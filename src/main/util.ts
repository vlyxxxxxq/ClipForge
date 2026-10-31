import fs from 'node:fs';
import path from 'node:path';
import { spawn, SpawnOptions } from 'node:child_process';

/** Atomic JSON write: write a temp file beside the target, fsync, then rename over it. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    // Fall back to a leftover temp file from an interrupted write, if any.
    return fallback;
  }
}

/** True if `child` resolves inside `parent` (both made absolute). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Remove a path only if it is inside an app-owned root. */
export function safeRemove(root: string, target: string): void {
  if (!isInside(root, target)) throw new Error(`Refusing to delete outside app directory: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/g, '').trim().slice(0, 120);
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  return !cleaned || reserved.test(cleaned) ? 'clip' : cleaned;
}

/** Pick a non-existing path: name.mp4, name (2).mp4, ... */
export function uniquePath(dir: string, base: string, ext: string): string {
  let p = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

/** Run a process with an argument array (never a shell) and collect output. */
export function run(cmd: string, args: string[], opts: SpawnOptions & { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout?.on('data', (d) => (stdout += d));
    p.stderr?.on('data', (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : null;
    p.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    p.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
