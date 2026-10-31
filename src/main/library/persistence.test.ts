import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryStore } from './libraryStore';
import { defaultSettings, SettingsStore } from '../settings';
import { isInside, safeRemove, sanitizeFileName, uniquePath } from '../util';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-test-')); dirs.push(d); return d; };
afterEach(() => { dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })); });

const media = {
  probe: async () => ({ duration: 12.5, width: 1920, height: 1080, fps: 60, audioTracks: ['Desktop'] }),
  thumbnail: async (_s: string, dest: string) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'jpg'); },
};
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

describe('library persistence', () => {
  it('persists records, edits and survives reload', async () => {
    const d = tmp();
    const clip = path.join(d, 'a.mp4');
    fs.writeFileSync(clip, 'video');
    const lib = new LibraryStore(d, path.join(d, 'thumbs'), media);
    const rec = await lib.addFile(clip, 'capture');
    await until(() => lib.get(rec.id)!.status === 'ok');
    lib.patch(rec.id, { title: 'Ace', favorite: true, tags: ['ranked'] });
    lib.flush();
    const again = new LibraryStore(d, path.join(d, 'thumbs'), media);
    expect(again.get(rec.id)).toMatchObject({ title: 'Ace', favorite: true, tags: ['ranked'], durationSec: 12.5, status: 'ok' });
    expect(await again.addFile(clip, 'capture')).toMatchObject({ id: rec.id }); // no duplicates
  });

  it('marks missing files and restores them when they return', async () => {
    const d = tmp();
    const clip = path.join(d, 'b.mp4');
    fs.writeFileSync(clip, 'v');
    const lib = new LibraryStore(d, path.join(d, 'thumbs'), media);
    const rec = await lib.addFile(clip, 'capture');
    await until(() => lib.get(rec.id)!.status === 'ok');
    fs.renameSync(clip, clip + '.moved');
    await lib.verifyAll();
    expect(lib.get(rec.id)!.status).toBe('missing');
    fs.renameSync(clip + '.moved', clip);
    await lib.verifyAll();
    await until(() => lib.get(rec.id)!.status === 'ok');
    expect(lib.get(rec.id)!.status).toBe('ok');
  });

  it('marks corrupt media without throwing', async () => {
    const d = tmp();
    const clip = path.join(d, 'c.mp4');
    fs.writeFileSync(clip, 'x');
    const lib = new LibraryStore(d, path.join(d, 't'), { ...media, probe: async () => { throw new Error('moov atom not found'); } });
    const rec = await lib.addFile(clip, 'capture');
    await until(() => lib.get(rec.id)!.status !== 'pending');
    expect(lib.get(rec.id)!.status).toBe('corrupt');
  });

  it('tolerates a corrupted library file', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'library.json'), '{not json');
    expect(new LibraryStore(d, d, media).list()).toEqual([]);
  });
});

describe('settings persistence', () => {
  it('validates and persists settings', () => {
    const d = tmp();
    const file = path.join(d, 'settings.json');
    const s = new SettingsStore(file, defaultSettings('C:\\Videos'));
    s.set({ capture: { replayDuration: 90, hotkey: 'Alt+F9', fps: 45, quality: 'nope', clipsDir: 'relative' }, general: { closeToTray: false } });
    const r = new SettingsStore(file, defaultSettings('C:\\Videos')).get();
    expect(r.capture.replayDuration).toBe(90);
    expect(r.capture.hotkey).toBe('Alt+F9');
    expect(r.capture.fps).toBe(60);
    expect(r.capture.quality).toBe('high');
    expect(r.capture.clipsDir).toBe(path.join('C:\\Videos', 'ClipForge'));
    expect(r.general.closeToTray).toBe(false);
  });
});

describe('path safety', () => {
  it('only deletes inside the app root', () => {
    const d = tmp();
    expect(isInside(d, path.join(d, 'a', 'b'))).toBe(true);
    expect(isInside(d, path.join(d, '..', 'x'))).toBe(false);
    expect(isInside(d, d)).toBe(false);
    expect(() => safeRemove(path.join(d, 'root'), d)).toThrow();
  });
  it('sanitizes names and avoids overwrites', () => {
    expect(sanitizeFileName('a<b>:c?.. ')).toBe('abc');
    expect(sanitizeFileName('CON')).toBe('clip');
    const d = tmp();
    fs.writeFileSync(path.join(d, 'x.mp4'), '');
    expect(path.basename(uniquePath(d, 'x', '.mp4'))).toBe('x (2).mp4');
  });
});
