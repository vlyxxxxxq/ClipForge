import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings';

// Fake child processes: no ffmpeg, no capture devices, no desktop.
class FakeProc extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { write: vi.fn((c: string) => { if (c === 'q') setTimeout(() => this.exit(0), 0); }), end: vi.fn(() => setTimeout(() => this.exit(0), 0)) });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  kill = vi.fn(() => { this.exit(1); return true; });
  constructor(public cmd: string, public args: string[]) { super(); }
  exit(code: number) { if (this.exitCode !== null) return; this.exitCode = code; this.emit('close', code); }
  progress() { this.stdout.emit('data', 'fps=60\ndrop_frames=0\nspeed=1.0x\n'); }
}

const h = vi.hoisted(() => ({
  procs: [] as any[],
  spawnError: null as Error | null,
  monitors: async () => [{ index: 0, label: 'Display 1', width: 1920, height: 1080 }] as any[],
}));

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (cmd: string, args: string[]) => {
    const p = new FakeProc(cmd, args);
    h.procs.push(p);
    if (cmd.includes('AudioCap')) setTimeout(() => p.stdout.emit('data', 'ready\n'), 0);
    else if (h.spawnError) { const e = h.spawnError; setTimeout(() => { p.emit('error', e); }, 0); }
    return p;
  },
}));
vi.mock('../media', () => ({
  ffmpeg: () => 'ffmpeg.exe',
  probe: async () => ({ duration: 2, audioTracks: [] }),
  listMonitors: () => h.monitors(),
  detectEncoders: async () => [{ id: 'libx264', label: 'x264', hardware: false, available: true }, { id: 'h264_amf', label: 'AMF', hardware: true, available: true }],
}));

import { CaptureService } from './captureService';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean) => { for (let i = 0; i < 400 && !fn(); i++) await tick(); expect(fn()).toBe(true); };

describe('CaptureService lifecycle', () => {
  let root: string;
  let svc: CaptureService;
  const ffs = () => h.procs.filter((p) => !p.cmd.includes('AudioCap'));
  const live = () => h.procs.filter((p) => p.exitCode === null);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-svc-'));
    h.procs.length = 0;
    h.spawnError = null;
    h.monitors = async () => [{ index: 0, label: 'Display 1', width: 1920, height: 1080 }];
    svc = new CaptureService(path.join(root, 'buffer'), 'AudioCap.exe');
    svc.configure({ ...defaultSettings(root).capture, clipsDir: path.join(root, 'clips'), desktopAudio: true, micEnabled: false, encoder: 'auto' });
  });
  afterEach(async () => { await svc.stop(); fs.rmSync(root, { recursive: true, force: true }); });

  it('reports recording only after ffmpeg makes progress', async () => {
    await svc.start();
    expect(svc.getStatus().state).toBe('starting');
    ffs()[0].progress();
    expect(svc.getStatus().state).toBe('recording');
  });

  it('a stop during startup wins: nothing is left running', async () => {
    let release!: () => void;
    h.monitors = () => new Promise((r) => { release = () => r([{ index: 0, label: 'D', width: 1920, height: 1080 }]); });
    const started = svc.start();
    await until(() => !!release);
    const stopped = svc.stop();
    release();
    await Promise.all([started, stopped]);
    expect(h.procs).toHaveLength(0);
    expect(svc.getStatus().state).toBe('stopped');
  });

  it('runs one session when start and stop are mixed quickly', async () => {
    const ops = [svc.start(), svc.stop(), svc.start(), svc.stop(), svc.start()];
    await Promise.all(ops);
    await until(() => ffs().length > 0);
    expect(live().filter((p) => !p.cmd.includes('AudioCap'))).toHaveLength(1);
    expect(svc.getStatus().state).toBe('starting');
  });

  it('reports a failed ffmpeg launch instead of crashing', async () => {
    h.spawnError = new Error('spawn ffmpeg.exe ENOENT');
    await svc.start();
    await until(() => svc.getStatus().state === 'error');
    expect(svc.getStatus().lastError).toContain('ENOENT');
    expect(ffs()).toHaveLength(1); // no pointless retry when the program cannot start at all
  });

  it('retries once with software encoding when the hardware encoder fails at startup', async () => {
    await svc.start();
    ffs()[0].stderr.emit('data', 'amf init failed');
    ffs()[0].exit(1);
    await until(() => ffs().length === 2);
    expect(svc.getStatus().encoder).toBe('libx264');
    expect(svc.getStatus().encoderFallbackReason).toContain('amf init failed');
    ffs()[1].progress();
    expect(svc.getStatus().state).toBe('recording');
  });

  it('pauses and notifies instead of capturing another display', async () => {
    svc.configure({ ...defaultSettings(root).capture, clipsDir: path.join(root, 'clips'), monitorIndex: 5 });
    const lost = vi.fn();
    svc.on('source-lost', lost);
    await svc.start();
    expect(svc.getStatus().state).toBe('paused');
    expect(svc.getStatus().lastError).toContain('display is unavailable');
    expect(lost).toHaveBeenCalledOnce();
    expect(h.procs).toHaveLength(0);
  });

  it('pauses when the display disappears mid-session', async () => {
    svc.configure({ ...defaultSettings(root).capture, clipsDir: path.join(root, 'clips'), encoder: 'libx264' });
    await svc.start();
    ffs()[0].progress();
    h.monitors = async () => [{ index: 3, label: 'Other', width: 1280, height: 720 }];
    ffs()[0].exit(1);
    await until(() => svc.getStatus().state === 'paused');
    expect(ffs()).toHaveLength(1);
  });

  it('restarts after a failure at most three times in five minutes', async () => {
    svc.configure({ ...defaultSettings(root).capture, clipsDir: path.join(root, 'clips'), encoder: 'libx264' });
    await svc.start();
    for (let i = 0; i < 3; i++) {
      const n = ffs().length;
      ffs()[n - 1].progress();
      ffs()[n - 1].exit(1);
      await until(() => ffs().length === n + 1);
    }
    const last = ffs()[ffs().length - 1];
    last.progress();
    last.exit(1);
    await until(() => svc.getStatus().state === 'error');
    expect(ffs()).toHaveLength(4);
  });

  it('a device loss restarts capture and uses the same budget', async () => {
    await svc.start();
    ffs()[0].progress();
    const helper = h.procs.find((p) => p.cmd.includes('AudioCap'));
    helper.exit(1);
    await until(() => ffs().length === 2);
    ffs()[1].progress();
    await until(() => svc.getStatus().warnings.some((w) => w.includes('device lost')));
    expect(live().filter((p) => !p.cmd.includes('AudioCap'))).toHaveLength(1);
  });

  it('ignores an old helper that exits after its session ended', async () => {
    await svc.start();
    ffs()[0].progress();
    const old = h.procs.find((p) => p.cmd.includes('AudioCap'));
    await svc.pause();
    await svc.resume();
    const n = ffs().length;
    ffs()[n - 1].progress();
    old.emit('close', 1);
    await tick(20);
    expect(ffs()).toHaveLength(n);
    expect(svc.getStatus().state).toBe('recording');
  });
});
