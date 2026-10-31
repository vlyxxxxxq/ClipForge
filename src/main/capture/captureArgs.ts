// Pure builder for the long-running capture ffmpeg command.
import type { CaptureSettings, Quality } from '../../shared/types';

export const SEGMENT_SEC = 2;

export interface CaptureArgInput {
  settings: CaptureSettings;
  encoder: 'h264_amf' | 'h264_nvenc' | 'h264_qsv' | 'libx264';
  sourceWidth: number;
  sourceHeight: number;
  audioPipes: { pipe: string; title: string; volume: number }[];
  segmentDir: string;
  join: (a: string, b: string) => string;
}

const BITRATE: Record<Quality, Record<number, number>> = {
  // Mbps at 1080p-equivalent; scaled by pixel count below.
  low: { 30: 6, 60: 9 },
  medium: { 30: 10, 60: 15 },
  high: { 30: 16, 60: 24 },
  ultra: { 30: 24, 60: 36 },
};

export function targetSize(s: CaptureSettings, sw: number, sh: number): { w: number; h: number } {
  const h = s.resolution === 'native' ? sh : { '1440p': 1440, '1080p': 1080, '720p': 720 }[s.resolution];
  const outH = Math.min(h, sh);
  const outW = Math.round((sw * outH) / sh / 2) * 2;
  return { w: outW, h: Math.round(outH / 2) * 2 };
}

export function videoBitrateMbps(s: CaptureSettings, w: number, h: number): number {
  const base = BITRATE[s.quality][s.fps];
  return Math.max(2, Math.round(base * Math.max(0.4, (w * h) / (1920 * 1080))));
}

function encoderArgs(enc: CaptureArgInput['encoder'], mbps: number, gop: number): string[] {
  const rate = ['-b:v', `${mbps}M`, '-maxrate', `${Math.round(mbps * 1.5)}M`, '-bufsize', `${mbps * 2}M`];
  switch (enc) {
    case 'h264_amf':
      // forced_idr + header_spacing are required for AMF to honour forced keyframes (verified).
      return ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'speed', '-rc', 'vbr_peak', ...rate, '-g', String(gop), '-forced_idr', '1', '-header_spacing', String(gop)];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'vbr', ...rate, '-g', String(gop), '-forced-idr', '1'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', ...rate, '-g', String(gop), '-forced_idr', '1'];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', ...rate, '-g', String(gop), '-pix_fmt', 'yuv420p'];
  }
}

export function buildCaptureArgs(i: CaptureArgInput): string[] {
  const s = i.settings;
  const { w, h } = targetSize(s, i.sourceWidth, i.sourceHeight);
  const args = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1', '-progress', 'pipe:1', '-y'];
  i.audioPipes.forEach((a) => {
    args.push('-thread_queue_size', '2048', '-f', 'f32le', '-ar', '48000', '-ch_layout', 'stereo', '-i', `\\\\.\\pipe\\${a.pipe}`);
  });
  const scale = w !== i.sourceWidth || h !== i.sourceHeight ? `,scale=${w}:${h}:flags=bilinear` : '';
  const fmt = i.encoder === 'libx264' ? 'yuv420p' : 'nv12';
  const filters = [`ddagrab=output_idx=${s.monitorIndex}:framerate=${s.fps}:draw_mouse=1,hwdownload,format=bgra${scale},format=${fmt}[v]`];
  const amaps: string[] = [];
  i.audioPipes.forEach((a, k) => {
    filters.push(`[${k}:a]volume=${a.volume.toFixed(2)}[a${k}]`);
    amaps.push(`[a${k}]`);
  });
  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  amaps.forEach((m) => args.push('-map', m));
  const gop = s.fps * SEGMENT_SEC;
  args.push(...encoderArgs(i.encoder, videoBitrateMbps(s, w, h), gop), '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SEC})`);
  if (i.audioPipes.length) args.push('-c:a', 'aac', '-b:a', '160k');
  i.audioPipes.forEach((a, k) => args.push(`-metadata:s:a:${k}`, `title=${a.title}`));
  args.push(
    '-f', 'segment', '-segment_time', String(SEGMENT_SEC), '-segment_format', 'mpegts', '-reset_timestamps', '0',
    '-segment_list', i.join(i.segmentDir, 'segments.csv'), '-segment_list_type', 'csv',
    i.join(i.segmentDir, 'seg_%06d.ts'),
  );
  return args;
}

/** Args to remux selected segments (via concat script) into a finalized MP4 without re-encoding. */
export function buildSaveArgs(concatFile: string, outFile: string, titles: string[]): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-map', '0', '-c', 'copy'];
  titles.forEach((t, k) => args.push(`-metadata:s:a:${k}`, `title=${t}`, `-metadata:s:a:${k}`, `handler_name=${t}`));
  args.push('-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-f', 'mp4', outFile);
  return args;
}
