// Background capture: owns the audio helper processes, the ffmpeg capture process, the segmented
// disk buffer and clip saving. Runs entirely in the main process (no window required); the heavy
// work happens in child processes.
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { buildCaptureArgs, buildSaveArgs, SEGMENT_SEC, targetSize } from './captureArgs';
import { BufferSegment, concatScript, ReplayBuffer } from './replayBuffer';
import { ffmpeg, listMonitors, probe, detectEncoders } from '../media';
import { freeDiskBytes, isInside, run, safeRemove } from '../util';
import { log } from '../logger';
import type { CaptureSettings, CaptureStatus, EncoderInfo, MonitorInfo, RecoveryInfo } from '../../shared/types';

const L = log('capture');
const LOW_DISK_WARN = 2 * 1024 ** 3;
const LOW_DISK_STOP = 500 * 1024 ** 2;
const RETENTION_MARGIN = 3 * SEGMENT_SEC; // keep a little extra beyond the replay duration

type HwEncoder = Exclude<EncoderInfo['id'], never>;

export interface SavedClip { file: string; durationSec: number; audioTracks: string[] }

export class CaptureService extends EventEmitter {
  private settings!: CaptureSettings;
  private buffer = new ReplayBuffer(60);
  private ff: ChildProcess | null = null;
  private helpers: ChildProcess[] = [];
  private session = 0;
  private sessionDir: string | null = null;
  private listOffset = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private diskTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private encoders: EncoderInfo[] | null = null;
  private monitors: MonitorInfo[] | null = null;
  private lastSaveRequest = 0;
  private saveChain: Promise<unknown> = Promise.resolve();
  private segmentWaiters: (() => void)[] = [];
  private status: CaptureStatus;

  constructor(private bufferRoot: string, private audioHelper: string) {
    super();
    fs.mkdirSync(bufferRoot, { recursive: true });
    this.status = {
      state: 'stopped', bufferedSeconds: 0, replayDuration: 60, encoder: null, encoderFallbackReason: null, fps: null,
      droppedFrames: 0, speed: null, hotkey: 'F8', hotkeyRegistered: false, hotkeyError: null, lastError: null, warnings: [],
      savingCount: 0, freeDiskBytes: null, audioTracks: [],
    };
  }

  getStatus(): CaptureStatus { return { ...this.status, bufferedSeconds: Math.round(this.buffer.bufferedSeconds()) }; }
  private update(p: Partial<CaptureStatus>) { Object.assign(this.status, p); this.emit('status', this.getStatus()); }
  setHotkeyStatus(hotkey: string, ok: boolean, err: string | null) { this.update({ hotkey, hotkeyRegistered: ok, hotkeyError: err }); }

  configure(s: CaptureSettings) {
    this.settings = s;
    this.buffer.setRetention(s.replayDuration + RETENTION_MARGIN);
    this.update({ replayDuration: s.replayDuration });
  }

  async getEncoders(refresh = false) { if (!this.encoders || refresh) this.encoders = await detectEncoders(); return this.encoders; }
  async getMonitors(refresh = false) { if (!this.monitors || refresh) this.monitors = await listMonitors(); return this.monitors; }

  async listAudioDevices() {
    const r = await run(this.audioHelper, ['list'], { timeoutMs: 10000 });
    if (r.code !== 0) throw new Error('Audio device enumeration failed: ' + r.stderr.trim());
    return JSON.parse(r.stdout);
  }

  get isActive() { return this.status.state === 'recording' || this.status.state === 'starting'; }

  // ---- lifecycle ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.isActive) return;
    const s = this.settings;
    this.update({ state: 'starting', lastError: null, warnings: [] });
    try {
      const free = await freeDiskBytes(this.bufferRoot);
      if (free !== null && free < LOW_DISK_STOP) throw new Error(`Not enough free disk space for the replay buffer (${(free / 1024 ** 2).toFixed(0)} MB free).`);
      const monitors = await this.getMonitors();
      if (!monitors.length) throw new Error('No capturable display found (Desktop Duplication unavailable).');
      let mon = monitors.find((m) => m.index === s.monitorIndex);
      const warnings: string[] = [];
      if (!mon) {
        mon = monitors[0];
        warnings.push(`Selected display is unavailable; capturing ${mon.label} instead.`);
        this.monitors = null;
      }
      const encoder = await this.pickEncoder();
      await this.launch({ ...s, monitorIndex: mon.index }, mon, encoder.id, warnings);
      this.update({ encoder: encoder.id, encoderFallbackReason: encoder.reason });
      this.startDiskMonitor();
    } catch (e: any) {
      L.error('start failed: ' + e.message);
      await this.killProcesses();
      this.update({ state: 'error', lastError: e.message });
    }
  }

  private async pickEncoder(): Promise<{ id: HwEncoder; reason: string | null }> {
    const encs = await this.getEncoders();
    const want = this.settings.encoder;
    if (want !== 'auto') {
      const e = encs.find((x) => x.id === want);
      if (e?.available) return { id: e.id, reason: null };
      const fb = encs.find((x) => x.hardware && x.available) ?? encs.find((x) => x.id === 'libx264')!;
      return { id: fb.id, reason: `${want} unavailable (${e?.error ?? 'not supported'}); using ${fb.label}.` };
    }
    const hw = encs.find((x) => x.hardware && x.available);
    if (hw) return { id: hw.id, reason: null };
    return { id: 'libx264', reason: 'No working hardware encoder found; using software x264 (higher CPU use).' };
  }

  private async launch(s: CaptureSettings, mon: MonitorInfo, encoder: HwEncoder, warnings: string[], allowFallback = true) {
    this.session++;
    this.sessionDir = path.join(this.bufferRoot, `session-${Date.now()}`);
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.listOffset = 0;

    const pipes: { pipe: string; title: string; volume: number }[] = [];
    const tracks: { source: 'loopback' | 'mic'; device: string | null; title: string; volume: number }[] = [];
    if (s.desktopAudio) tracks.push({ source: 'loopback', device: s.desktopDeviceId, title: 'Desktop', volume: s.desktopVolume });
    if (s.micEnabled) tracks.push({ source: 'mic', device: s.micDeviceId, title: 'Microphone', volume: s.micVolume });
    for (const t of tracks) {
      try {
        const pipe = `clipforge_${t.source}_${process.pid}_${this.session}`;
        await this.spawnHelper(pipe, t.source, t.device);
        pipes.push({ pipe, title: t.title, volume: t.volume });
      } catch (e: any) {
        warnings.push(`${t.title} audio unavailable: ${e.message}`);
      }
    }

    const args = buildCaptureArgs({ settings: s, encoder, sourceWidth: mon.width, sourceHeight: mon.height, audioPipes: pipes, segmentDir: this.sessionDir, join: path.join });
    L.info(`launch session ${this.session} ${encoder} ${mon.width}x${mon.height} -> ${JSON.stringify(targetSize(s, mon.width, mon.height))} tracks=${pipes.map((p) => p.title)}`);
    const ff = spawn(ffmpeg(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.ff = ff;
    this.stopping = false;
    let stderr = '';
    ff.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    ff.stdout!.on('data', (d) => this.onProgress(String(d)));
    const startedAt = Date.now();
    const session = this.session;
    ff.on('close', (code) => {
      if (this.ff !== ff) return;
      this.ff = null;
      this.stopPolling();
      this.pollSegments();
      if (this.stopping) return;
      const msg = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `ffmpeg exited with code ${code}`;
      L.error(`capture ffmpeg exited (${code}) session ${session}: ${msg}`);
      this.killHelpers();
      // Early encoder failure: retry once with the software encoder and say so.
      if (allowFallback && encoder !== 'libx264' && Date.now() - startedAt < 8000) {
        this.update({ encoder: 'libx264', encoderFallbackReason: `${encoder} failed to start (${msg.slice(0, 160)}); using software x264.` });
        this.launch(s, mon, 'libx264', warnings, false).catch((e) => this.update({ state: 'error', lastError: e.message }));
        return;
      }
      // Mid-session failure (display disconnected, mode change, driver reset): re-detect sources and
      // restart, at most 3 times per 5 minutes. The buffer keeps earlier sessions' segments until they expire.
      const now = Date.now();
      this.autoRestarts = this.autoRestarts.filter((t) => now - t < 300000);
      if (Date.now() - startedAt >= 8000 && this.autoRestarts.length < 3) {
        this.autoRestarts.push(now);
        this.monitors = null;
        this.update({ state: 'stopped' });
        this.start().then(() => this.update({ warnings: [...this.status.warnings, `Capture restarted after an error: ${msg.slice(0, 160)}`] }));
        return;
      }
      this.update({ state: 'error', lastError: `Capture stopped unexpectedly: ${msg}` });
    });
    this.pollTimer = setInterval(() => this.pollSegments(), 250);
    this.update({ state: 'recording', warnings, audioTracks: pipes.map((p) => p.title), droppedFrames: 0 });
  }

  private spawnHelper(pipe: string, source: string, device: string | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['capture', '--pipe', pipe, '--source', source];
      if (device) args.push('--device', device);
      const p = spawn(this.audioHelper, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let err = '';
      let ready = false;
      const t = setTimeout(() => { p.kill(); reject(new Error('audio helper did not start')); }, 8000);
      p.stderr!.on('data', (d) => { err = (err + d).slice(-2000); });
      p.stdout!.on('data', (d) => { if (!ready && String(d).includes('ready')) { ready = true; clearTimeout(t); resolve(); } });
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('close', (code) => {
        clearTimeout(t);
        const msg = err.trim().split('\n').pop() || `exit ${code}`;
        if (!ready) return reject(new Error(msg.replace(/^fatal: /, '')));
        this.helpers = this.helpers.filter((h) => h !== p);
        if (!this.stopping && this.ff && code !== 0) {
          // A device vanished mid-session. Restart capture so audio and video stay aligned.
          L.warn(`audio helper ${source} exited: ${msg}`);
          this.restartAfterDeviceLoss(`${source === 'mic' ? 'Microphone' : 'Desktop audio'} device lost (${msg}). Capture restarted.`);
        }
      });
      this.helpers.push(p);
    });
  }

  private restarting = false;
  private autoRestarts: number[] = [];
  private async restartAfterDeviceLoss(warning: string) {
    if (this.restarting) return;
    this.restarting = true;
    try {
      await this.stopProcesses();
      this.update({ state: 'stopped' });
      await this.start();
      this.update({ warnings: [...this.status.warnings, warning] });
    } finally { this.restarting = false; }
  }

  private onProgress(chunk: string) {
    const kv = Object.fromEntries(chunk.split(/\r?\n/).map((l) => l.split('=')).filter((x) => x.length === 2));
    const fps = kv.fps !== undefined ? Number(kv.fps) : this.status.fps;
    const drop = kv.drop_frames !== undefined ? Number(kv.drop_frames) : this.status.droppedFrames;
    const speed = kv.speed ? parseFloat(kv.speed) : this.status.speed;
    this.update({ fps, droppedFrames: drop, speed: Number.isFinite(speed) ? speed : null });
  }

  private pollSegments() {
    if (!this.sessionDir) return;
    const listFile = path.join(this.sessionDir, 'segments.csv');
    let text: string;
    try {
      const fd = fs.openSync(listFile, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size <= this.listOffset) return;
        const buf = Buffer.alloc(size - this.listOffset);
        fs.readSync(fd, buf, 0, buf.length, this.listOffset);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return; }
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return;
    this.listOffset += Buffer.byteLength(text.slice(0, lastNl + 1));
    let added = 0;
    for (const line of text.slice(0, lastNl).split('\n')) {
      const seg = ReplayBuffer.parseListLine(line, this.sessionDir, this.session, path.join);
      if (seg) { this.buffer.add(seg); added++; }
    }
    if (added) {
      this.cleanup();
      const w = this.segmentWaiters; this.segmentWaiters = []; w.forEach((f) => f());
      this.update({});
    }
  }

  private cleanup() {
    for (const s of this.buffer.collectExpired()) this.deleteSegment(s.file);
  }

  private deleteSegment(file: string) {
    if (!isInside(this.bufferRoot, file)) return;
    fs.promises.unlink(file).catch((e) => { if (e.code !== 'ENOENT') L.warn(`could not delete segment: ${e.code}`); });
  }

  private startDiskMonitor() {
    if (this.diskTimer) return;
    const check = async () => {
      const free = await freeDiskBytes(this.bufferRoot);
      const clipsFree = await freeDiskBytes(this.settings.clipsDir);
      const min = Math.min(free ?? Infinity, clipsFree ?? Infinity);
      this.update({ freeDiskBytes: Number.isFinite(min) ? min : null });
      if (min < LOW_DISK_STOP && this.isActive) {
        await this.stop();
        this.update({ state: 'error', lastError: `Capture stopped: disk almost full (${(min / 1024 ** 2).toFixed(0)} MB free). Free up space and start again.` });
      } else if (min < LOW_DISK_WARN) {
        const w = `Low disk space: ${(min / 1024 ** 3).toFixed(1)} GB free.`;
        if (!this.status.warnings.includes(w)) this.update({ warnings: [...this.status.warnings.filter((x) => !x.startsWith('Low disk')), w] });
      }
    };
    check();
    this.diskTimer = setInterval(check, 10000);
  }

  private stopPolling() { if (this.pollTimer) clearInterval(this.pollTimer); this.pollTimer = null; }

  private killHelpers() {
    for (const h of this.helpers) { try { h.stdin?.end(); } catch {} setTimeout(() => { if (h.exitCode === null) h.kill(); }, 1500); }
    this.helpers = [];
  }

  /** Gracefully end ffmpeg ('q' finalizes the current segment), then the helpers. */
  private async stopProcesses() {
    this.stopping = true;
    const ff = this.ff;
    if (ff) {
      const done = new Promise<void>((r) => ff.once('close', () => r()));
      try { ff.stdin?.write('q'); } catch {}
      const t = setTimeout(() => ff.kill(), 4000);
      await done;
      clearTimeout(t);
    }
    this.killHelpers();
    this.stopPolling();
  }

  private async killProcesses() { this.stopping = true; this.ff?.kill(); this.ff = null; this.killHelpers(); this.stopPolling(); }

  async pause() {
    if (!this.isActive) return;
    await this.stopProcesses();
    this.update({ state: 'paused', fps: null, speed: null });
  }

  async resume() { if (this.status.state === 'paused') await this.start(); }

  async stop() {
    await this.stopProcesses();
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.diskTimer = null;
    for (const s of this.buffer.clear()) if (isInside(this.bufferRoot, s.file)) fs.rmSync(s.file, { force: true });
    this.removeEmptySessionDirs();
    this.update({ state: 'stopped', fps: null, speed: null });
  }

  async shutdown() { await this.stop(); }

  // ---- saving ------------------------------------------------------------------------------

  /**
   * Save the last N seconds. Presses within 1 s of the previous request are ignored; saves run one
   * after another. While recording, waits for the in-progress segment to be finalized so the clip
   * includes the moment of the press and every file is complete.
   */
  requestSave(clipPath: (ext: string) => string): Promise<SavedClip | null> {
    const now = Date.now();
    if (now - this.lastSaveRequest < 1000) return Promise.resolve(null);
    this.lastSaveRequest = now;
    const state = this.status.state;
    if (state !== 'recording' && state !== 'paused') return Promise.reject(new Error('Capture is not running.'));
    const seqAtPress = this.buffer.totalAdded; // seq of the segment being written right now
    const duration = this.settings.replayDuration;
    const sessionAtPress = this.session;
    this.update({ savingCount: this.status.savingCount + 1 });
    const job = this.saveChain.then(async () => {
      try {
        if (this.ff && this.session === sessionAtPress) await this.waitForSegment(seqAtPress, SEGMENT_SEC * 4000);
        const segs = this.buffer.select(duration, seqAtPress);
        if (!segs.length) throw new Error('The replay buffer is empty — wait a few seconds after starting capture.');
        this.buffer.pin(segs);
        try { return await this.writeClip(segs, clipPath); } finally { this.buffer.unpin(segs); this.cleanup(); }
      } finally {
        this.update({ savingCount: Math.max(0, this.status.savingCount - 1) });
      }
    });
    this.saveChain = job.catch(() => {});
    return job;
  }

  /** Resolve once the segment with this seq has been finalized (or capture ended / timeout). */
  private waitForSegment(seq: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.buffer.totalAdded > seq) return resolve();
      const t = setTimeout(() => resolve(), timeoutMs);
      const check = () => { if (this.buffer.totalAdded > seq || !this.ff) { clearTimeout(t); resolve(); } else this.segmentWaiters.push(check); };
      this.segmentWaiters.push(check);
    });
  }

  private async writeClip(segs: BufferSegment[], clipPath: (ext: string) => string): Promise<SavedClip> {
    const final = clipPath('.mp4');
    const dir = path.dirname(final);
    fs.mkdirSync(dir, { recursive: true });
    const free = await freeDiskBytes(dir);
    const need = segs.reduce((a, s) => a + (fs.existsSync(s.file) ? fs.statSync(s.file).size : 0), 0);
    if (free !== null && free < need * 1.2 + 50 * 1024 ** 2) throw new Error('Not enough disk space to save the clip.');
    const listFile = path.join(path.dirname(segs[0].file), `concat-${Date.now()}.ffconcat`);
    fs.writeFileSync(listFile, concatScript(segs));
    const tmp = path.join(dir, `.clipforge-tmp-${Date.now()}.mp4`);
    try {
      const r = await run(ffmpeg(), buildSaveArgs(listFile, tmp, this.status.audioTracks), { timeoutMs: 120000 });
      if (r.code !== 0) throw new Error('Saving clip failed: ' + r.stderr.trim().split('\n').slice(-2).join(' '));
      const info = await probe(tmp); // validate before exposing it to the library
      if (info.duration <= 0) throw new Error('Saved clip has no duration.');
      fs.renameSync(tmp, final);
      L.info(`saved clip ${path.basename(final)} ${info.duration.toFixed(2)}s from ${segs.length} segments`);
      return { file: final, durationSec: info.duration, audioTracks: info.audioTracks };
    } finally {
      fs.promises.unlink(listFile).catch(() => {});
      fs.promises.unlink(tmp).catch(() => {});
    }
  }

  // ---- recovery ----------------------------------------------------------------------------

  /** Leftover session folders from a crash or power loss (the app was not shut down cleanly). */
  findOrphans(): RecoveryInfo[] {
    const out: RecoveryInfo[] = [];
    for (const name of safeReaddir(this.bufferRoot)) {
      const dir = path.join(this.bufferRoot, name);
      if (!name.startsWith('session-') || dir === this.sessionDir) continue;
      const segs = readSessionList(dir).filter((s) => fs.existsSync(s.file));
      if (!segs.length) { safeRemove(this.bufferRoot, dir); continue; }
      out.push({ sessionDir: dir, segments: segs.length, seconds: Math.round(segs.reduce((a, s) => a + s.end - s.start, 0)) });
    }
    return out;
  }

  async recoverOrphan(dir: string, clipPath: (ext: string) => string): Promise<SavedClip> {
    if (!isInside(this.bufferRoot, dir)) throw new Error('Invalid recovery folder');
    const segs = readSessionList(dir).filter((s) => fs.existsSync(s.file));
    const b = new ReplayBuffer(Infinity);
    segs.forEach((s) => b.add(s));
    const sel = b.select(this.settings.replayDuration);
    if (!sel.length) throw new Error('No usable segments in the recovered buffer.');
    const titles = (await probe(sel[0].file).catch(() => null))?.audioTracks ?? [];
    const prev = this.status.audioTracks;
    this.status.audioTracks = titles;
    try { return await this.writeClip(sel, clipPath); } finally { this.status.audioTracks = prev; }
  }

  discardOrphan(dir: string) { safeRemove(this.bufferRoot, dir); }

  private removeEmptySessionDirs() {
    for (const name of safeReaddir(this.bufferRoot)) {
      const dir = path.join(this.bufferRoot, name);
      if (!name.startsWith('session-')) continue;
      const left = safeReaddir(dir).filter((f) => f.endsWith('.ts'));
      if (!left.length) safeRemove(this.bufferRoot, dir);
    }
  }
}

function safeReaddir(dir: string): string[] { try { return fs.readdirSync(dir); } catch { return []; } }

function readSessionList(dir: string): BufferSegment[] {
  try {
    return fs.readFileSync(path.join(dir, 'segments.csv'), 'utf8').split('\n')
      .map((l) => ReplayBuffer.parseListLine(l, dir, 0, path.join)).filter((s): s is BufferSegment => !!s);
  } catch { return []; }
}
