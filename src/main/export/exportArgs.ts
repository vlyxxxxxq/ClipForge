// Pure builder for the export ffmpeg command. Everything is re-encoded, so cuts are frame-accurate.
import { canvasSize, cropRect, EditProject, outputDuration } from '../../shared/project';
import type { ExportOptions, Quality } from '../../shared/types';

const CRF: Record<Quality, number> = { low: 28, medium: 23, high: 20, ultra: 17 };

export interface ExportArgInput {
  project: EditProject;
  options: ExportOptions;
  sourceFps: number;
  outFile: string;
  /** Text files holding overlay text (avoids escaping user text into the filter graph). */
  textFiles: string[];
  fontFile: string;
}

/** Escape a value for use inside a filter option (single-quoted). */
export function filterPath(p: string): string {
  return "'" + p.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:') + "'";
}

const f3 = (n: number) => (Math.round(n * 1000) / 1000).toString();

export function buildExportArgs(i: ExportArgInput): { args: string[]; duration: number; width: number; height: number; hasAudio: boolean } {
  const p = i.project;
  const { width: W, height: H } = canvasSize(p, i.options.resolution);
  const crop = cropRect(p);
  const segs = p.segments;
  const n = segs.length;
  const fps = i.options.fps === 'source' ? Math.min(60, Math.round(i.sourceFps) || 60) : i.options.fps;

  // Audio tracks that are present and not muted.
  const tracks: { index: number; volume: number }[] = [];
  if (p.source.audioTracks.length > 0 && !p.audio.desktopMuted) tracks.push({ index: 0, volume: p.audio.desktopVolume });
  if (p.source.audioTracks.length > 1 && !p.audio.micMuted) tracks.push({ index: 1, volume: p.audio.micVolume });

  const g: string[] = [];
  const vLabels = segs.map((_, k) => `[vs${k}]`);
  g.push(n > 1 ? `[0:v]split=${n}${vLabels.join('')}` : `[0:v]null${vLabels[0]}`);
  segs.forEach((s, k) => g.push(`${vLabels[k]}trim=start=${f3(s.start)}:end=${f3(s.end)},setpts=PTS-STARTPTS[v${k}]`));
  tracks.forEach((t, ti) => {
    const labels = segs.map((_, k) => `[as${ti}_${k}]`);
    g.push(n > 1 ? `[0:a:${t.index}]asplit=${n}${labels.join('')}` : `[0:a:${t.index}]anull${labels[0]}`);
    segs.forEach((s, k) => g.push(`${labels[k]}atrim=start=${f3(s.start)}:end=${f3(s.end)},asetpts=PTS-STARTPTS[a${ti}_${k}]`));
  });
  // concat interleaves per segment: [v0][a0_0][a1_0][v1][a0_1][a1_1]...
  const concatIn = segs.map((_, k) => `[v${k}]` + tracks.map((_, ti) => `[a${ti}_${k}]`).join('')).join('');
  const aOut = tracks.map((_, ti) => `[ac${ti}]`).join('');
  g.push(`${concatIn}concat=n=${n}:v=1:a=${tracks.length}[vc]${aOut}`);

  let v = `[vc]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${W}:${H}:flags=lanczos,setsar=1,fps=${fps}`;
  p.texts.forEach((t, k) => {
    if (!t.text.trim() || t.end <= t.start) return;
    const size = Math.max(8, Math.round(t.size * H));
    const color = /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#ffffff';
    v += `,drawtext=fontfile=${filterPath(i.fontFile)}:textfile=${filterPath(i.textFiles[k])}:expansion=none:fontsize=${size}` +
      `:fontcolor=${color}:borderw=${Math.max(1, Math.round(size / 14))}:bordercolor=black@0.85` +
      `:x=${f3(t.x * W)}-text_w/2:y=${f3(t.y * H)}-text_h/2:enable='between(t\\,${f3(t.start)}\\,${f3(t.end)})'`;
  });
  g.push(`${v},format=yuv420p[vout]`);
  if (tracks.length === 1) g.push(`[ac0]volume=${f3(tracks[0].volume)}[aout]`);
  if (tracks.length === 2) {
    g.push(`[ac0]volume=${f3(tracks[0].volume)}[am0]`, `[ac1]volume=${f3(tracks[1].volume)}[am1]`);
    g.push(`[am0][am1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.98[aout]`);
  }

  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y', '-i', p.source.path,
    '-filter_complex', g.join(';'), '-map', '[vout]'];
  if (tracks.length) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF[i.options.quality]), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-f', 'mp4', i.outFile);
  return { args, duration: outputDuration(p), width: W, height: H, hasAudio: tracks.length > 0 };
}

/** Parse ffmpeg -progress output; returns seconds processed, or null. */
export function parseProgress(chunk: string): { outTime: number | null; ended: boolean } {
  let outTime: number | null = null;
  for (const line of chunk.split(/\r?\n/)) {
    const m = /^out_time_us=(\d+)/.exec(line);
    if (m) outTime = Number(m[1]) / 1e6;
  }
  return { outTime, ended: /progress=end/.test(chunk) };
}
