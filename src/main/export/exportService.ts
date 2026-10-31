// Runs export jobs as ffmpeg child processes; writes to a temp file and renames only on success.
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildExportArgs, parseProgress } from './exportArgs';
import { ffmpeg, probe } from '../media';
import { freeDiskBytes, isInside, safeRemove, sanitizeFileName, uniquePath } from '../util';
import { log } from '../logger';
import type { EditProject } from '../../shared/project';
import type { ExportJob, ExportOptions } from '../../shared/types';

const L = log('export');
const FONT = 'C:\\Windows\\Fonts\\segoeuib.ttf';

export class ExportService extends EventEmitter {
  private jobs = new Map<string, { job: ExportJob; proc: ChildProcess | null; tmp: string; workDir: string }>();

  constructor(private tempRoot: string) { super(); fs.mkdirSync(tempRoot, { recursive: true }); }

  /** Remove leftovers from interrupted exports (app-owned temp dir only). */
  cleanupOrphans() {
    for (const name of fs.readdirSync(this.tempRoot)) safeRemove(this.tempRoot, path.join(this.tempRoot, name));
  }

  list() { return [...this.jobs.values()].map((j) => j.job); }

  async start(clipId: string, project: EditProject, options: ExportOptions, outDir: string, sourceFps: number): Promise<ExportJob> {
    if (!fs.existsSync(project.source.path)) throw new Error('The original clip file is missing.');
    fs.mkdirSync(outDir, { recursive: true });
    const id = crypto.randomUUID();
    const workDir = path.join(this.tempRoot, id);
    fs.mkdirSync(workDir);
    const textFiles = project.texts.map((t, k) => { const f = path.join(workDir, `text${k}.txt`); fs.writeFileSync(f, t.text, 'utf8'); return f; });
    const tmp = path.join(workDir, 'output.mp4');
    const font = fs.existsSync(FONT) ? FONT : 'C:\\Windows\\Fonts\\arial.ttf';
    const built = buildExportArgs({ project, options, sourceFps, outFile: tmp, textFiles, fontFile: font });
    const free = await freeDiskBytes(outDir);
    if (free !== null && free < 300 * 1024 ** 2) throw new Error('Not enough free disk space to export.');

    const job: ExportJob = { id, clipId, state: 'running', progress: 0, outputPath: null, error: null };
    const proc = spawn(ffmpeg(), built.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const entry = { job, proc: proc as ChildProcess | null, tmp, workDir };
    this.jobs.set(id, entry);
    let stderr = '';
    proc.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.stdout!.on('data', (d) => {
      const { outTime } = parseProgress(String(d));
      if (outTime !== null && built.duration > 0) { job.progress = Math.min(0.99, outTime / built.duration); this.emit('job', { ...job }); }
    });
    proc.on('close', async (code) => {
      entry.proc = null;
      try {
        if (job.state === 'cancelled') return;
        if (code !== 0) throw new Error(stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) || `ffmpeg exited with ${code}`);
        const info = await probe(tmp);
        if (Math.abs(info.duration - built.duration) > 0.25) L.warn(`export duration ${info.duration} vs expected ${built.duration}`);
        const final = uniquePath(outDir, sanitizeFileName(options.fileName), '.mp4');
        fs.renameSync(tmp, final);
        Object.assign(job, { state: 'done', progress: 1, outputPath: final });
        L.info(`export done ${built.width}x${built.height} ${info.duration.toFixed(2)}s`);
      } catch (e: any) {
        Object.assign(job, { state: 'failed', error: e.message });
        L.error('export failed: ' + e.message);
      } finally {
        safeRemove(this.tempRoot, workDir);
        this.emit('job', { ...job });
      }
    });
    proc.on('error', (e) => { Object.assign(job, { state: 'failed', error: e.message }); this.emit('job', { ...job }); });
    this.emit('job', { ...job });
    return { ...job };
  }

  /** Cancel kills ffmpeg and removes only this job's temp folder. */
  cancel(id: string) {
    const e = this.jobs.get(id);
    if (!e || e.job.state !== 'running') return;
    e.job.state = 'cancelled';
    e.proc?.kill();
    if (!e.proc && isInside(this.tempRoot, e.workDir)) safeRemove(this.tempRoot, e.workDir);
    this.emit('job', { ...e.job });
  }

  cancelAll() { for (const id of this.jobs.keys()) this.cancel(id); }
}
