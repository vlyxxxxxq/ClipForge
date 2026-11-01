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
    return fallback;
  }
}

/** Atomic write that first keeps the previous good version as `<file>.bak`. */
export function writeJsonWithBackup(file: string, data: unknown): void {
  // Never let a damaged file replace the last good backup.
  if (readJson<unknown>(file, null)) fs.copyFileSync(file, `${file}.bak`);
  writeJsonAtomic(file, data);
}

/** Copy a damaged file aside so it can still be inspected or repaired. Returns the copy's name. */
export function quarantine(file: string): string | null {
  const copy = `${file}.damaged-${Date.now()}`;
  try { fs.copyFileSync(file, copy); return path.basename(copy); } catch { return null; }
}

export interface LoadedDocument<T> {
  value: T | null;
  /** Something the user should be told about; null when all is well. */
  notice: string | null;
  /** The file is from a newer version of the app and must not be overwritten. */
  readOnly: boolean;
}

/**
 * Load a versioned JSON document without ever hiding damage: a bad file is copied aside and the last
 * good backup is used if there is one. `parse` returns null when the content isn't valid.
 */
export function loadDocument<T>(file: string, label: string, currentVersion: number | null, parse: (raw: any) => T | null): LoadedDocument<T> {
  const read = (f: string): { ok: boolean; raw?: any } => {
    try { return { ok: true, raw: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return { ok: false }; }
  };
  const fromBackup = (intro: string): LoadedDocument<T> => {
    const bak = read(`${file}.bak`);
    const value = bak.ok ? parse(bak.raw) : null;
    return { value, readOnly: false, notice: value ? `${intro} Restored the last good copy; your most recent changes may be missing.` : `${intro} Starting fresh.` };
  };
  if (!fs.existsSync(file)) return fs.existsSync(`${file}.bak`) ? fromBackup(`Your ${label} file was missing.`) : { value: null, notice: null, readOnly: false };
  const main = read(file);
  if (main.ok && currentVersion !== null && typeof main.raw?.version === 'number' && main.raw.version > currentVersion)
    return { value: null, readOnly: true, notice: `Your ${label} file comes from a newer version of ClipForge. It won't be changed, and changes made now won't be saved.` };
  const value = main.ok ? parse(main.raw) : null;
  if (value) return { value, notice: null, readOnly: false };
  const copy = quarantine(file);
  return fromBackup(`Your ${label} file was damaged${copy ? ` (a copy was kept as ${copy})` : ''}.`);
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
