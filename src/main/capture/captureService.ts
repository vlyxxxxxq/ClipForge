// Background capture: owns the audio helper processes, the ffmpeg capture process, the segmented
// disk buffer and clip saving. Runs entirely in the main process (no window required); the heavy
// work happens in child processes.
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { buildCaptureArgs, buildSaveArgs, SEGMENT_SEC, targetSize } from './captureArgs';
import { BufferSegment, concatScript, ReplayBuffer } from './replayBuffer';
import { ClipPath, SaveCoordinator, SavedClip } from './saveCoordinator';
import { ffmpeg, listMonitors, probe, detectEncoders } from '../media';
import { retentionFor } from '../hotkeys';
import { freeDiskBytes, isInside, run, safeRemove } from '../util';
import { log } from '../logger';
import type { CaptureSettings, CaptureStatus, EncoderInfo, MonitorInfo, RecoveryInfo } from '../../shared/types';

const L = log('capture');
const LOW_DISK_WARN = 2 * 1024 ** 3;
const LOW_DISK_STOP = 500 * 1024 ** 2;
const READY_TIMEOUT_MS = 20000; // ffmpeg reports progress every second once it is really capturing
const HELPER_EXIT_TIMEOUT_MS = 2500;

/** A start that a later stop or pause overtook. */
class Superseded extends Error {}

type HwEncoder = Exclude<EncoderInfo['id'], never>;

export type { SavedClip };

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
  private generation = 0; // bumped by stop/pause/restart; a start from an older generation gives up
  private lifecycle: Promise<unknown> = Promise.resolve(); // start/stop/pause run strictly one at a time
  private encoders: EncoderInfo[] | null = null;
  private monitors: MonitorInfo[] | null = null;
  private saves: SaveCoordinator;
  private status: CaptureStatus;

  constructor(private bufferRoot: string, private audioHelper: string) {
    super();
    fs.mkdirSync(bufferRoot, { recursive: true });
    this.status = {
      state: 'stopped', bufferedSeconds: 0, replayDuration: 60, encoder: null, encoderFallbackReason: null, fps: null,
      droppedFrames: 0, speed: null, hotkey: 'F8', hotkeyRegistered: false, hotkeyError: null, hotkeyWarnings: [], lastError: null, warnings: [],
      savingCount: 0, freeDiskBytes: null, audioTracks: [],
    };
    this.saves = new SaveCoordinator({
      buffer: this.buffer,
      session: () => this.session,
      capturing: () => this.ff !== null,
      write: (segs, tracks, clipPath) => this.writeClip(segs, tracks, clipPath),
      onPendingChange: (savingCount) => this.update({ savingCount }),
      released: () => this.cleanup(),
      segmentTimeoutMs: SEGMENT_SEC * 4000,
    });
  }

  getStatus(): CaptureStatus { return { ...this.status, bufferedSeconds: Math.round(this.buffer.bufferedSeconds()) }; }
  private update(p: Partial<CaptureStatus>) { Object.assign(this.status, p); this.emit('status', this.getStatus()); }
  setHotkeyStatus(hotkey: string, ok: boolean, err: string | null, warnings: string[]) { this.update({ hotkey, hotkeyRegistered: ok, hotkeyError: err, hotkeyWarnings: warnings }); }

  configure(s: CaptureSettings) {
    this.settings = s;
    this.buffer.setRetention(retentionFor(s));
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

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(op);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  private checkCurrent(gen: number) { if (gen !== this.generation) throw new Superseded(); }

  start(): Promise<void> {
    const gen = this.generation;
    return this.enqueue(() => this.doStart(gen));
  }

  private async doStart(gen: number): Promise<void> {
    if (this.isActive || gen !== this.generation) return;
    const s = this.settings;
    this.update({ state: 'starting', lastError: null, warnings: [] });
    try {
      const free = await freeDiskBytes(this.bufferRoot);
      this.checkCurrent(gen);
      if (free !== null && free < LOW_DISK_STOP) throw new Error(`Not enough free disk space for the replay buffer (${(free / 1024 ** 2).toFixed(0)} MB free).`);
      const monitors = await this.getMonitors();
      this.checkCurrent(gen);
      if (!monitors.length) throw new Error('No capturable display found (Desktop Duplication unavailable).');
      const mon = monitors.find((m) => m.index === s.monitorIndex);
      if (!mon) {
        // Never switch to another screen on our own: it could show something private.
        this.monitors = null;
        const msg = 'The selected display is unavailable, so capture is paused. Reconnect it or choose another display, then resume.';
        this.update({ state: 'paused', lastError: msg, fps: null, speed: null });
        this.emit('source-lost', msg);
        return;
      }
      const encoder = await this.pickEncoder();
      this.checkCurrent(gen);
      await this.launch({ ...s, monitorIndex: mon.index }, mon, encoder.id, [], gen);
      this.update({ encoder: encoder.id, encoderFallbackReason: encoder.reason });
      this.startDiskMonitor();
    } catch (e: any) {
      await this.killProcesses();
      if (e instanceof Superseded) return; // the command that overtook this start sets the final state
      L.error('start failed: ' + e.message);
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

  private async launch(s: CaptureSettings, mon: MonitorInfo, encoder: HwEncoder, warnings: string[], gen: number, allowFallback = true) {
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
      this.checkCurrent(gen);
    }

    const args = buildCaptureArgs({ settings: s, encoder, sourceWidth: mon.width, sourceHeight: mon.height, audioPipes: pipes, segmentDir: this.sessionDir, join: path.join });
    L.info(`launch session ${this.session} ${encoder} ${mon.width}x${mon.height} -> ${JSON.stringify(targetSize(s, mon.width, mon.height))} tracks=${pipes.map((p) => p.title)}`);
    const ff = spawn(ffmpeg(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.ff = ff;
    this.stopping = false;
    let stderr = '';
    let progressed = false;
    let exited = false;
    ff.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    ff.stdin!.on('error', (e) => L.warn('capture stdin: ' + e.message));
    ff.stdout!.on('data', (d) => {
      if (this.ff !== ff) return;
      progressed = true;
      clearTimeout(readyTimer);
      if (this.status.state === 'starting') this.update({ state: 'recording' });
      this.onProgress(String(d));
    });
    const readyTimer = setTimeout(() => { if (this.ff === ff) { stderr += ' ffmpeg did not start capturing in time.'; ff.kill(); } }, READY_TIMEOUT_MS);
    const startedAt = Date.now();
    const session = this.session;
    const onExit = (code: number | null, err?: Error) => {
      if (exited) return;
      exited = true;
      clearTimeout(readyTimer);
      if (this.ff !== ff) return;
      this.ff = null;
      this.stopPolling();
      this.pollSegments();
      this.saves.captureEnded();
      if (this.stopping) return;
      const msg = err?.message ?? (stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `ffmpeg exited with code ${code}`);
      L.error(`capture ffmpeg exited (${code}) session ${session}: ${msg}`);
      this.killHelpers();
      const gen = this.generation;
      // Failed before capturing anything: retry once with the software encoder and say so.
      if (allowFallback && encoder !== 'libx264' && !err && (!progressed || Date.now() - startedAt < 8000)) {
        this.update({ encoder: 'libx264', encoderFallbackReason: `${encoder} failed to start (${msg.slice(0, 160)}); using software x264.` });
        this.enqueue(() => this.launch(s, mon, 'libx264', warnings, gen, false)).catch((e) => {
          if (!(e instanceof Superseded)) this.update({ state: 'error', lastError: e.message });
        });
        return;
      }
      // Mid-session failure (display disconnected, mode change, driver reset): re-detect sources and
      // restart. The buffer keeps earlier sessions' segments until they expire.
      if (progressed && this.allowRestart()) {
        this.monitors = null;
        this.update({ state: 'stopped' });
        this.enqueue(async () => {
          await this.doStart(gen);
          if (this.isActive) this.update({ warnings: [...this.status.warnings, `Capture restarted after an error: ${msg.slice(0, 160)}`] });
        });
        return;
      }
      this.update({ state: 'error', lastError: `Capture stopped unexpectedly: ${msg}` });
    };
    ff.on('error', (e) => onExit(null, e));
    ff.on('close', (code) => onExit(code));
    this.pollTimer = setInterval(() => this.pollSegments(), 250);
    this.update({ state: 'starting', warnings, audioTracks: pipes.map((p) => p.title), droppedFrames: 0 });
  }

  private spawnHelper(pipe: string, source: string, device: string | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['capture', '--pipe', pipe, '--source', source];
      if (device) args.push('--device', device);
      const session = this.session;
      const p = spawn(this.audioHelper, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      p.stdin!.on('error', (e) => L.warn('audio helper stdin: ' + e.message));
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
        if (this.session === session && !this.stopping && this.ff && code !== 0) {
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

  /** At most 3 automatic restarts per 5 minutes, across every kind of failure. */
  private allowRestart(): boolean {
    const now = Date.now();
    this.autoRestarts = this.autoRestarts.filter((t) => now - t < 300000);
    if (this.autoRestarts.length >= 3) return false;
    this.autoRestarts.push(now);
    return true;
  }

  private restartAfterDeviceLoss(warning: string) {
    if (this.restarting) return;
    this.restarting = true;
    const gen = ++this.generation;
    this.enqueue(async () => {
      try {
        await this.stopProcesses();
        if (gen !== this.generation) return;
        if (!this.allowRestart()) { this.update({ state: 'error', lastError: `Capture stopped: ${warning}` }); return; }
        this.update({ state: 'stopped' });
        await this.doStart(gen);
        if (this.isActive) this.update({ warnings: [...this.status.warnings, warning] });
      } finally { this.restarting = false; }
    });
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
      this.saves.segmentAdded();
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

  /** Ask the helpers to exit (they quit when stdin closes) and wait for them, within reason. */
  private killHelpers(): Promise<void> {
    const helpers = this.helpers;
    this.helpers = [];
    return Promise.all(helpers.map((h) => new Promise<void>((resolve) => {
      if (h.exitCode !== null) return resolve();
      const t = setTimeout(() => { h.kill(); resolve(); }, HELPER_EXIT_TIMEOUT_MS);
      h.once('close', () => { clearTimeout(t); resolve(); });
      try { h.stdin?.end(); } catch {}
    }))).then(() => {});
  }

  /** Gracefully end ffmpeg ('q' finalizes the current segment), then the helpers. */
  private async stopProcesses() {
    this.stopping = true;
    const ff = this.ff;
    if (ff) {
      const done = new Promise<void>((r) => { ff.once('close', () => r()); ff.once('error', () => r()); });
      try { ff.stdin?.write('q'); } catch {}
      const t = setTimeout(() => ff.kill(), 4000);
      await done;
      clearTimeout(t);
    }
    await this.killHelpers();
    this.stopPolling();
  }

  private async killProcesses() { this.stopping = true; this.ff?.kill(); this.ff = null; this.saves.captureEnded(); await this.killHelpers(); this.stopPolling(); }

  pause(): Promise<void> {
    this.generation++;
    return this.enqueue(async () => {
      if (!this.isActive) return;
      await this.stopProcesses();
      this.update({ state: 'paused', fps: null, speed: null });
    });
  }

  resume(): Promise<void> {
    const gen = this.generation;
    return this.enqueue(async () => { if (this.status.state === 'paused') await this.doStart(gen); });
  }

  stop(): Promise<void> {
    this.generation++;
    return this.enqueue(async () => {
      await this.stopProcesses();
      if (this.diskTimer) clearInterval(this.diskTimer);
      this.diskTimer = null;
      this.update({ state: 'stopped', fps: null, speed: null, lastError: null });
      await this.saves.drain(); // accepted saves finish before their segments are removed
      for (const s of this.buffer.clear()) if (isInside(this.bufferRoot, s.file)) fs.rmSync(s.file, { force: true });
      this.removeEmptySessionDirs();
    });
  }

  async shutdown() { await this.stop(); }

  // ---- saving ------------------------------------------------------------------------------

  /**
   * Save the last N seconds. See SaveCoordinator: footage is reserved at the press, repeated presses
   * are ignored, and while recording the clip also includes the segment being written at the press.
   */
  requestSave(clipPath: ClipPath, duration?: number): Promise<SavedClip | null> {
    const state = this.status.state;
    if (state !== 'recording' && state !== 'paused') return Promise.reject(new Error('Capture is not running.'));
    return this.saves.request(duration ?? this.settings.replayDuration, this.status.audioTracks, clipPath);
  }

  private async writeClip(segs: BufferSegment[], tracks: string[], clipPath: ClipPath): Promise<SavedClip> {
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
      const r = await run(ffmpeg(), buildSaveArgs(listFile, tmp, tracks), { timeoutMs: 120000 });
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

  async recoverOrphan(dir: string, clipPath: ClipPath): Promise<SavedClip> {
    if (!isInside(this.bufferRoot, dir)) throw new Error('Invalid recovery folder');
    const segs = readSessionList(dir).filter((s) => fs.existsSync(s.file));
    const b = new ReplayBuffer(Infinity);
    segs.forEach((s) => b.add(s));
    const sel = b.select(this.settings.replayDuration);
    if (!sel.length) throw new Error('No usable segments in the recovered buffer.');
    const titles = (await probe(sel[0].file).catch(() => null))?.audioTracks ?? [];
    return this.writeClip(sel, titles, clipPath);
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
