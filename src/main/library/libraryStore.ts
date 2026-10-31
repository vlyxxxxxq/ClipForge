// Durable clip metadata: a JSON document written atomically, plus an async thumbnail queue.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic } from '../util';
import { log } from '../logger';
import type { ClipRecord } from '../../shared/types';

const L = log('library');

export interface MediaOps {
  probe(file: string): Promise<{ duration: number; width: number; height: number; fps: number; audioTracks: string[] }>;
  thumbnail(src: string, dest: string, at: number): Promise<void>;
}

interface LibraryFile { version: 1; clips: ClipRecord[] }

export class LibraryStore extends EventEmitter {
  private clips = new Map<string, ClipRecord>();
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private thumbQueue: string[] = [];
  private thumbBusy = false;

  constructor(private dataDir: string, private thumbDir: string, private media: MediaOps) {
    super();
    this.file = path.join(dataDir, 'library.json');
    const data = readJson<LibraryFile>(this.file, { version: 1, clips: [] });
    for (const c of data.clips ?? []) if (c?.id && c.filePath) this.clips.set(c.id, c);
  }

  list(): ClipRecord[] { return [...this.clips.values()]; }
  get(id: string) { return this.clips.get(id); }

  /** Re-check every file on disk: marks moved/deleted files as missing and recovers them if they come back. */
  async verifyAll() {
    for (const c of this.clips.values()) {
      const exists = fs.existsSync(c.filePath);
      if (!exists && c.status !== 'missing') this.patch(c.id, { status: 'missing' });
      else if (exists && c.status === 'missing') { this.patch(c.id, { status: 'pending' }); this.enqueueThumb(c.id, true); }
      else if (exists && (!c.thumbnail || !fs.existsSync(c.thumbnail)) && c.status !== 'corrupt') this.enqueueThumb(c.id);
    }
  }

  async addFile(filePath: string, kind: ClipRecord['kind'], extra: Partial<ClipRecord> = {}): Promise<ClipRecord> {
    const existing = this.list().find((c) => path.resolve(c.filePath) === path.resolve(filePath));
    if (existing) return existing;
    const id = crypto.randomUUID();
    const stat = fs.statSync(filePath);
    const rec: ClipRecord = {
      id, title: path.basename(filePath, path.extname(filePath)), filePath, createdAt: stat.birthtime.toISOString(),
      durationSec: 0, width: 0, height: 0, fps: 0, sizeBytes: stat.size, audioTracks: [], favorite: false, tags: [],
      thumbnail: null, status: 'pending', kind, ...extra,
    };
    this.clips.set(id, rec);
    this.persist();
    this.enqueueThumb(id, true);
    return rec;
  }

  patch(id: string, p: Partial<ClipRecord>): ClipRecord | undefined {
    const c = this.clips.get(id);
    if (!c) return undefined;
    const next = { ...c, ...p, id: c.id };
    this.clips.set(id, next);
    this.persist();
    return next;
  }

  /** Remove the record; optionally delete the media file (only on explicit user confirmation). */
  remove(id: string, deleteFile: boolean) {
    const c = this.clips.get(id);
    if (!c) return;
    if (deleteFile && fs.existsSync(c.filePath)) fs.rmSync(c.filePath);
    if (c.thumbnail && c.thumbnail.startsWith(this.thumbDir)) fs.rmSync(c.thumbnail, { force: true });
    this.clips.delete(id);
    this.persist();
  }

  async relink(id: string, newPath: string) {
    if (!fs.existsSync(newPath)) throw new Error('File not found');
    this.patch(id, { filePath: newPath, status: 'pending' });
    this.enqueueThumb(id, true);
  }

  private enqueueThumb(id: string, refreshMeta = false) {
    if (!this.thumbQueue.some((q) => q.split('|')[0] === id)) this.thumbQueue.push(id + (refreshMeta ? '|meta' : ''));
    this.pumpThumbs();
  }

  private async pumpThumbs() {
    if (this.thumbBusy) return;
    this.thumbBusy = true;
    try {
      while (this.thumbQueue.length) {
        const [id, meta] = this.thumbQueue.shift()!.split('|');
        const c = this.clips.get(id);
        if (!c) continue;
        try {
          const st = fs.statSync(c.filePath);
          let info = { durationSec: c.durationSec, width: c.width, height: c.height, fps: c.fps, audioTracks: c.audioTracks };
          if (meta || !c.durationSec) {
            const p = await this.media.probe(c.filePath);
            info = { durationSec: p.duration, width: p.width, height: p.height, fps: p.fps, audioTracks: p.audioTracks };
          }
          const thumb = path.join(this.thumbDir, `${id}.jpg`);
          await this.media.thumbnail(c.filePath, thumb, Math.min(info.durationSec * 0.3, 5));
          this.patch(id, { ...info, sizeBytes: st.size, thumbnail: thumb, status: 'ok' });
        } catch (e: any) {
          L.warn(`thumbnail/probe failed for ${id}: ${e.message?.slice(0, 200)}`);
          this.patch(id, { status: fs.existsSync(c.filePath) ? 'corrupt' : 'missing' });
        }
      }
    } finally { this.thumbBusy = false; }
  }

  private persist() {
    this.emit('changed');
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 150);
  }

  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    writeJsonAtomic(this.file, { version: 1, clips: this.list() } satisfies LibraryFile);
  }
}
