import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../../shared/project';

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  outFile: string;
  killed = false;
  constructor(public args: string[]) { super(); this.outFile = args[args.length - 1]; fs.writeFileSync(this.outFile, 'encoding'); }
  kill() { this.killed = true; setTimeout(() => this.emit('close', 1), 0); return true; }
  finish(code = 0) { this.emit('close', code); }
}

const h = vi.hoisted(() => ({
  procs: [] as any[],
  probe: (async () => ({ duration: 10, width: 1280, height: 720, audioTracks: ['Desktop', 'Microphone'], fps: 60, videoCodec: 'h264' })) as () => Promise<any>,
}));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (_cmd: string, args: string[]) => { const p = new FakeProc(args); h.procs.push(p); return p; },
}));
vi.mock('../media', () => ({ ffmpeg: () => 'ffmpeg.exe', probe: () => h.probe() }));

import { ExportService } from './exportService';

const tick = () => new Promise((r) => setTimeout(r, 2));
const opts = { resolution: '720p' as const, fps: 'source' as const, quality: 'high' as const, fileName: 'out' };

describe('ExportService', () => {
  let root: string, out: string, tmp: string, svc: ExportService, src: string;
  const project = () => createProject('c', { path: src, duration: 10, width: 1920, height: 1080, audioTracks: ['Desktop', 'Microphone'] });
  const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await tick(); expect(fn()).toBe(true); };
  const done = (id: string) => new Promise<any>((r) => svc.on('job', (j) => { if (j.id === id && ['done', 'failed', 'cancelled'].includes(j.state)) r(j); }));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-exp-'));
    out = path.join(root, 'Exports'); tmp = path.join(root, 'tmp');
    src = path.join(root, 'src.mp4'); fs.writeFileSync(src, 'x');
    h.procs.length = 0;
    h.probe = async () => ({ duration: 10, width: 1280, height: 720, audioTracks: ['Desktop', 'Microphone'], fps: 60, videoCodec: 'h264' });
    svc = new ExportService(tmp);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('encodes beside the destination and publishes only the validated file', async () => {
    const job = await svc.start('c', project(), opts, out, 60);
    const result = done(job.id);
    expect(path.dirname(h.procs[0].outFile)).toBe(out);
    expect(path.basename(h.procs[0].outFile)).toMatch(/^\.clipforge-export-/);
    h.procs[0].finish();
    const j = await result;
    expect(j.state).toBe('done');
    expect(j.outputPath).toBe(path.join(out, 'out.mp4'));
    expect(fs.readdirSync(out)).toEqual(['out.mp4']);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('never publishes after a cancel during validation, and reports it once', async () => {
    let release!: () => void;
    h.probe = () => new Promise((r) => { release = () => r({ duration: 10, width: 1280, height: 720, audioTracks: ['a', 'b'] }); });
    const job = await svc.start('c', project(), opts, out, 60);
    const events: string[] = [];
    svc.on('job', (j) => { if (j.id === job.id) events.push(j.state); });
    h.procs[0].finish();
    await until(() => !!release);
    svc.cancel(job.id);
    release();
    await until(() => events.includes('cancelled'));
    await tick();
    expect(events.filter((e) => e === 'cancelled')).toHaveLength(1);
    expect(events).not.toContain('done');
    expect(events).not.toContain('failed');
    expect(fs.readdirSync(out)).toEqual([]);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('runs one encoder at a time; cancelling a queued job spawns nothing', async () => {
    const a = await svc.start('c', project(), opts, out, 60);
    const b = await svc.start('c', project(), { ...opts, fileName: 'b' }, out, 60);
    const c = await svc.start('c', project(), { ...opts, fileName: 'c' }, out, 60);
    expect(a.state).toBe('running');
    expect(b.state).toBe('queued');
    expect(h.procs).toHaveLength(1);
    const cancelled = done(b.id);
    svc.cancel(b.id);
    expect((await cancelled).state).toBe('cancelled');
    const doneC = done(c.id);
    h.procs[0].finish();
    await until(() => h.procs.length === 2);
    h.procs[1].finish();
    expect((await doneC).outputPath).toBe(path.join(out, 'c.mp4'));
    expect(h.procs).toHaveLength(2);
  });

  it('fails and removes the file when the output is not what was asked for', async () => {
    h.probe = async () => ({ duration: 3, width: 1280, height: 720, audioTracks: ['a', 'b'] });
    const job = await svc.start('c', project(), opts, out, 60);
    const result = done(job.id);
    h.procs[0].finish();
    const j = await result;
    expect(j.state).toBe('failed');
    expect(j.error).toMatch(/duration/i);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('reports an ffmpeg launch error and moves on to the next job', async () => {
    const a = await svc.start('c', project(), opts, out, 60);
    const b = await svc.start('c', project(), { ...opts, fileName: 'b' }, out, 60);
    const failed = done(a.id);
    h.procs[0].emit('error', new Error('spawn ENOENT'));
    expect((await failed).error).toContain('ENOENT');
    await until(() => h.procs.length === 2);
    const doneB = done(b.id);
    h.procs[1].finish();
    expect((await doneB).state).toBe('done');
  });

  it('leaves nothing behind when setup fails', async () => {
    const bad = project();
    (bad as any).texts = [{ get text() { throw new Error('boom'); } }];
    await expect(svc.start('c', bad, opts, out, 60)).rejects.toThrow('boom');
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(h.procs).toHaveLength(0);
  });

  it('cleans only exact generated names from user folders', () => {
    fs.mkdirSync(out, { recursive: true });
    const keep = ['My clip.mp4', '.clipforge-export-notes.mp4', 'clipforge-tmp-1.mp4', '.clipforge-tmp-12.mp4.bak'];
    for (const n of keep) fs.writeFileSync(path.join(out, n), 'x');
    fs.writeFileSync(path.join(out, '.clipforge-export-3f2b8c1e-0000-4000-8000-123456789abc.mp4'), 'x');
    fs.writeFileSync(path.join(out, '.clipforge-tmp-1730000000000.mp4'), 'x');
    svc.cleanupOrphans([out, path.join(root, 'does-not-exist')]);
    expect(fs.readdirSync(out).sort()).toEqual([...keep].sort());
  });
});
