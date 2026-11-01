// Runs export jobs one at a time as ffmpeg child processes. Each job encodes to a hidden staging file
// beside its final location (so the final rename stays on one drive) and is renamed only once validated.
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildExportArgs, checkExportOutput, parseProgress } from './exportArgs';
import { ffmpeg, probe } from '../media';
import { freeDiskBytes, safeRemove, sanitizeFileName, uniquePath } from '../util';
import { log } from '../logger';
import type { EditProject } from '../../shared/project';
import type { ExportJob, ExportOptions } from '../../shared/types';

const L = log('export');
const FONT = 'C:\\Windows\\Fonts\\segoeuib.ttf';
const MAX_QUEUED = 8;
const SHUTDOWN_WAIT_MS = 5000;
/** Only these exact generated names are ever removed from a user-visible folder. */
const STAGING_NAME = /^\.clipforge-(export-[0-9a-f-]{36}\.mp4|tmp-\d+\.(mp4|png))$/;

interface Entry {
  job: ExportJob;
  proc: ChildProcess | null;
  args: string[];
  built: { duration: number; width: number; height: number; hasAudio: boolean };
  staging: string;
  workDir: string;
  outDir: string;
  fileName: string;
}

export class ExportService extends EventEmitter {
  private jobs = new Map<string, Entry>();
  private queue: Entry[] = [];
  private active: Entry | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(private tempRoot: string) { super(); fs.mkdirSync(tempRoot, { recursive: true }); }

  /** Remove leftovers from interrupted exports and saves: the app's temp folder and exact generated names. */
  cleanupOrphans(outDirs: string[] = []) {
    for (const name of fs.readdirSync(this.tempRoot)) safeRemove(this.tempRoot, path.join(this.tempRoot, name));
    for (const dir of outDirs) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) if (STAGING_NAME.test(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  }

  list() { return [...this.jobs.values()].map((e) => e.job); }

  async start(clipId: string, project: EditProject, options: ExportOptions, outDir: string, sourceFps: number): Promise<ExportJob> {
    if (!fs.existsSync(project.source.path)) throw new Error('The original clip file is missing.');
    if (this.queue.length >= MAX_QUEUED) throw new Error('Too many exports are waiting. Let some finish first.');
    fs.mkdirSync(outDir, { recursive: true });
    const free = await freeDiskBytes(outDir);
    if (free !== null && free < 300 * 1024 ** 2) throw new Error('Not enough free disk space to export.');

    const id = crypto.randomUUID();
    const workDir = path.join(this.tempRoot, id);
    fs.mkdirSync(workDir);
    try {
      const textFiles = project.texts.map((t, k) => { const f = path.join(workDir, `text${k}.txt`); fs.writeFileSync(f, t.text, 'utf8'); return f; });
      const staging = path.join(outDir, `.clipforge-export-${id}.mp4`);
      const font = fs.existsSync(FONT) ? FONT : 'C:\\Windows\\Fonts\\arial.ttf';
      const built = buildExportArgs({ project, options, sourceFps, outFile: staging, textFiles, fontFile: font });
      const job: ExportJob = { id, clipId, state: 'queued', progress: 0, outputPath: null, error: null };
      const entry: Entry = { job, proc: null, args: built.args, built, staging, workDir, outDir, fileName: options.fileName };
      this.jobs.set(id, entry);
      this.queue.push(entry);
      this.emit('job', { ...job });
      this.pump();
      return { ...job };
    } catch (e) {
      safeRemove(this.tempRoot, workDir);
      throw e;
    }
  }

  private pump() {
    if (this.active) return;
    const entry = this.queue.shift();
    if (!entry) { this.idleWaiters.splice(0).forEach((f) => f()); return; }
    this.active = entry;
    const { job, built } = entry;
    job.state = 'running';
    this.emit('job', { ...job });

    let settled = false;
    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      entry.proc = null;
      this.publish(entry, code, err, stderr);
    };
    let stderr = '';
    let proc: ChildProcess;
    try {
      proc = spawn(ffmpeg(), entry.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e: any) {
      finish(null, e);
      return;
    }
    entry.proc = proc;
    proc.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.stdout!.on('data', (d) => {
      const { outTime } = parseProgress(String(d));
      if (outTime !== null && built.duration > 0 && job.state === 'running') { job.progress = Math.min(0.99, outTime / built.duration); this.emit('job', { ...job }); }
    });
    proc.on('error', (e) => finish(null, e));
    proc.on('close', (code) => finish(code));
  }

  /** Validate and publish a finished encode. Cancellation is honored right up to the rename. */
  private async publish(entry: Entry, code: number | null, err: Error | undefined, stderr: string) {
    const { job, built } = entry;
    const cancelled = () => job.state === 'cancelled'; // cancel() can change this during any await
    try {
      if (cancelled()) return;
      if (err) throw err;
      if (code !== 0) throw new Error(stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) || `ffmpeg exited with ${code}`);
      const info = await probe(entry.staging);
      if (cancelled()) return;
      const problem = checkExportOutput(info, built);
      if (problem) throw new Error(problem);
      const final = uniquePath(entry.outDir, sanitizeFileName(entry.fileName), '.mp4');
      fs.renameSync(entry.staging, final);
      Object.assign(job, { state: 'done', progress: 1, outputPath: final });
      L.info(`export done ${built.width}x${built.height} ${info.duration.toFixed(2)}s`);
    } catch (e: any) {
      if (!cancelled()) {
        Object.assign(job, { state: 'failed', error: e.message });
        L.error('export failed: ' + e.message);
      }
    } finally {
      this.release(entry);
      this.emit('job', { ...job });
      this.active = null;
      this.pump();
    }
  }

  private release(entry: Entry) {
    fs.rmSync(entry.staging, { force: true });
    safeRemove(this.tempRoot, entry.workDir);
  }

  /** Cancel a job. It reports 'cancelled' once ffmpeg has stopped and its files are gone. */
  cancel(id: string) {
    const e = this.jobs.get(id);
    if (!e) return;
    if (e.job.state === 'queued') {
      this.queue = this.queue.filter((q) => q !== e);
      e.job.state = 'cancelled';
      this.release(e);
      this.emit('job', { ...e.job });
    } else if (e.job.state === 'running') {
      e.job.state = 'cancelled';
      e.proc?.kill();
    }
  }

  cancelAll() { for (const id of this.jobs.keys()) this.cancel(id); }

  /** Cancel everything and wait for ffmpeg to stop, within reason. */
  async shutdown() {
    this.cancelAll();
    if (!this.active) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, SHUTDOWN_WAIT_MS);
      this.idleWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
}
