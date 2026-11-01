// FFmpeg/ffprobe discovery and media inspection helpers.
import fs from 'node:fs';
import path from 'node:path';
import { buildScreenshotArgs } from './capture/captureArgs';
import { computePeaks, PEAK_SAMPLE_RATE } from '../shared/peaks';
import { run } from './util';
import { log } from './logger';
import type { EncoderInfo, MonitorInfo } from '../shared/types';

const L = log('media');
let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';

/** Locate ffmpeg: bundled resources/ffmpeg, then CLIPFORGE_FFMPEG_DIR, then PATH. */
export async function initMedia(resourcesDir: string): Promise<{ ok: boolean; version: string | null; error?: string }> {
  const candidates = [path.join(resourcesDir, 'ffmpeg'), process.env.CLIPFORGE_FFMPEG_DIR ?? ''].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'ffmpeg.exe')) && fs.existsSync(path.join(dir, 'ffprobe.exe'))) {
      ffmpegPath = path.join(dir, 'ffmpeg.exe');
      ffprobePath = path.join(dir, 'ffprobe.exe');
      break;
    }
  }
  try {
    const r = await run(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 10000 });
    const version = /ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? null;
    L.info(`ffmpeg ${version} at ${ffmpegPath}`);
    return { ok: r.code === 0, version };
  } catch (e) {
    return { ok: false, version: null, error: `FFmpeg was not found. Install it (e.g. "scoop install ffmpeg") or place ffmpeg.exe/ffprobe.exe in ${candidates[0]}.` };
  }
}

export const ffmpeg = () => ffmpegPath;
export const ffprobe = () => ffprobePath;

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
  audioTracks: string[];
  videoCodec: string | null;
}

export async function probe(file: string): Promise<ProbeResult> {
  const r = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 30000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'ffprobe failed');
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  if (!v) throw new Error('No video stream');
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
  const audio = j.streams.filter((s: any) => s.codec_type === 'audio');
  return {
    duration: Number(j.format.duration) || Number(v.duration) || 0,
    width: v.width,
    height: v.height,
    fps: d ? Math.round((n / d) * 100) / 100 : 0,
    audioTracks: audio.map((a: any, i: number) => a.tags?.title || (a.tags?.handler_name && !/handler/i.test(a.tags.handler_name) ? a.tags.handler_name : `Track ${i + 1}`)),
    videoCodec: v.codec_name ?? null,
  };
}

/** Probe DXGI outputs the way ddagrab sees them (index order matches output_idx). */
export async function listMonitors(): Promise<MonitorInfo[]> {
  const out: MonitorInfo[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await run(ffmpegPath, ['-hide_banner', '-v', 'verbose', '-filter_complex', `ddagrab=output_idx=${i}:framerate=5`, '-frames:v', '1', '-f', 'null', '-'], { timeoutMs: 8000 }).catch(() => null);
    const m = r && /Opened dxgi output \d+ with dimensions (\d+)x(\d+)/.exec(r.stderr);
    if (!m) break;
    out.push({ index: i, width: Number(m[1]), height: Number(m[2]), label: `Display ${i + 1} — ${m[1]}×${m[2]}` });
  }
  return out;
}

const ENCODERS: { id: EncoderInfo['id']; label: string; hardware: boolean }[] = [
  { id: 'h264_amf', label: 'AMD AMF (H.264)', hardware: true },
  { id: 'h264_nvenc', label: 'NVIDIA NVENC (H.264)', hardware: true },
  { id: 'h264_qsv', label: 'Intel Quick Sync (H.264)', hardware: true },
  { id: 'libx264', label: 'Software x264 (CPU)', hardware: false },
];

/** Test each encoder by actually encoding a few frames: being compiled in is not enough. */
export async function detectEncoders(): Promise<EncoderInfo[]> {
  const res: EncoderInfo[] = [];
  for (const e of ENCODERS) {
    const r = await run(ffmpegPath, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-frames:v', '10', '-pix_fmt', 'nv12', '-c:v', e.id, '-f', 'null', '-'], { timeoutMs: 15000 }).catch((err) => ({ code: -1, stdout: '', stderr: String(err) }));
    res.push({ ...e, available: r.code === 0, error: r.code === 0 ? undefined : r.stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200) });
  }
  L.info('encoders: ' + res.map((e) => `${e.id}=${e.available}`).join(' '));
  return res;
}

export async function makeThumbnail(src: string, dest: string, atSec: number): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp.jpg';
  const r = await run(ffmpegPath, ['-hide_banner', '-v', 'error', '-y', '-ss', String(Math.max(0, atSec)), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', tmp], { timeoutMs: 30000 });
  if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error(r.stderr.trim() || 'thumbnail failed');
  fs.renameSync(tmp, dest);
}

/** A strip of small frames for the editor timeline, as one horizontally tiled JPEG. */
export async function makeFilmstrip(src: string, dest: string, duration: number, count = 20): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp.jpg';
  const fps = count / Math.max(duration, 0.5);
  const r = await run(ffmpegPath, ['-hide_banner', '-v', 'error', '-y', '-i', src, '-vf', `fps=${fps.toFixed(4)},scale=160:-2,tile=${count}x1`, '-frames:v', '1', '-q:v', '5', tmp], { timeoutMs: 120000 });
  if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error(r.stderr.trim() || 'filmstrip failed');
  fs.renameSync(tmp, dest);
}

/** Extract one audio track (stream copy) for the editor's per-track preview playback. */
export async function extractAudioTrack(src: string, index: number, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp.m4a';
  const r = await run(ffmpegPath, ['-hide_banner', '-v', 'error', '-y', '-i', src, '-map', `0:a:${index}`, '-c', 'copy', '-f', 'mp4', tmp], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'audio extract failed');
  fs.renameSync(tmp, dest);
}

/** Save one real frame of a display, published only once it has been read back as a valid image. */
export async function takeScreenshot(monitorIndex: number, dest: string): Promise<{ width: number; height: number }> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.clipforge-tmp-${Date.now()}.png`);
  try {
    const r = await run(ffmpegPath, buildScreenshotArgs(monitorIndex, tmp), { timeoutMs: 15000 });
    if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error(r.stderr.trim().split('\n').pop() || 'The display could not be captured.');
    const info = await probe(tmp);
    fs.renameSync(tmp, dest);
    return { width: info.width, height: info.height };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Peak data for one audio track, cached as JSON. */
export async function makePeaks(src: string, index: number, dest: string): Promise<number[]> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp.raw';
  try {
    const r = await run(ffmpegPath, ['-hide_banner', '-v', 'error', '-y', '-i', src, '-map', `0:a:${index}`, '-ac', '1', '-ar', String(PEAK_SAMPLE_RATE), '-f', 's16le', tmp], { timeoutMs: 120000 });
    if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error(r.stderr.trim() || 'waveform failed');
    const raw = new Uint8Array(fs.readFileSync(tmp)); // copied, so the samples are correctly aligned
    const peaks = computePeaks(new Int16Array(raw.buffer, 0, Math.floor(raw.length / 2)));
    fs.writeFileSync(dest, JSON.stringify(peaks));
    return peaks;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
