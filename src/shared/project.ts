// Nondestructive edit project: pure data + calculations shared by the editor preview and the exporter.

export type AspectMode = 'original' | '16:9' | '9:16' | '1:1';

export interface Segment { id: string; start: number; end: number } // source seconds, kept in output order
export interface TextOverlay {
  id: string;
  text: string;
  x: number; // center, fraction of output width 0..1
  y: number; // center, fraction of output height 0..1
  size: number; // font size as a fraction of output height
  color: string; // #rrggbb
  start: number; // output-timeline seconds
  end: number;
}
export interface Framing { zoom: number; offsetX: number; offsetY: number } // zoom >= 1, offsets -1..1
export interface AudioMix { desktopVolume: number; desktopMuted: boolean; micVolume: number; micMuted: boolean }

export interface EditProject {
  version: 1;
  clipId: string;
  source: { path: string; duration: number; width: number; height: number; audioTracks: string[] };
  segments: Segment[];
  aspect: AspectMode;
  framing: Framing;
  audio: AudioMix;
  texts: TextOverlay[];
  updatedAt: string;
}

export const MIN_SEGMENT = 0.1;
let idCounter = 0;
export const newId = (p: string) => `${p}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export function createProject(clipId: string, source: EditProject['source']): EditProject {
  return {
    version: 1,
    clipId,
    source,
    segments: [{ id: newId('s'), start: 0, end: source.duration }],
    aspect: 'original',
    framing: { zoom: 1, offsetX: 0, offsetY: 0 },
    audio: { desktopVolume: 1, desktopMuted: false, micVolume: 1, micMuted: false },
    texts: [],
    updatedAt: new Date().toISOString(),
  };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function outputDuration(p: Pick<EditProject, 'segments'>): number {
  return round3(p.segments.reduce((a, s) => a + (s.end - s.start), 0));
}

/** Map output-timeline time to { segment index, source time }. Clamps to the ends. */
export function outputToSource(p: Pick<EditProject, 'segments'>, t: number): { index: number; time: number } {
  let acc = 0;
  for (let i = 0; i < p.segments.length; i++) {
    const s = p.segments[i];
    const len = s.end - s.start;
    if (t < acc + len || i === p.segments.length - 1) return { index: i, time: clamp(s.start + (t - acc), s.start, s.end) };
    acc += len;
  }
  return { index: 0, time: 0 };
}

/** Map a source time to the output timeline, or null if that source time was removed. */
export function sourceToOutput(p: Pick<EditProject, 'segments'>, src: number): number | null {
  let acc = 0;
  for (const s of p.segments) {
    if (src >= s.start - 1e-6 && src <= s.end + 1e-6) return round3(acc + clamp(src, s.start, s.end) - s.start);
    acc += s.end - s.start;
  }
  return null;
}

/** Split the segment under output time t. No-op if too close to a boundary. */
export function splitAt(p: EditProject, t: number): EditProject {
  const { index, time } = outputToSource(p, t);
  const s = p.segments[index];
  if (!s || time - s.start < MIN_SEGMENT || s.end - time < MIN_SEGMENT) return p;
  const segments = [...p.segments];
  segments.splice(index, 1, { id: newId('s'), start: s.start, end: round3(time) }, { id: newId('s'), start: round3(time), end: s.end });
  return { ...p, segments };
}

export function removeSegment(p: EditProject, id: string): EditProject {
  if (p.segments.length <= 1) return p;
  return clampTexts({ ...p, segments: p.segments.filter((s) => s.id !== id) });
}

/** Trim the output start (first segment's start) to a source time. */
export function setTrimStart(p: EditProject, srcTime: number): EditProject {
  const [first, ...rest] = p.segments;
  const start = round3(clamp(srcTime, 0, first.end - MIN_SEGMENT));
  return clampTexts({ ...p, segments: [{ ...first, start }, ...rest] });
}

export function setTrimEnd(p: EditProject, srcTime: number): EditProject {
  const segs = [...p.segments];
  const last = segs[segs.length - 1];
  segs[segs.length - 1] = { ...last, end: round3(clamp(srcTime, last.start + MIN_SEGMENT, p.source.duration)) };
  return clampTexts({ ...p, segments: segs });
}

function clampTexts(p: EditProject): EditProject {
  const d = outputDuration(p);
  return { ...p, texts: p.texts.map((t) => ({ ...t, start: clamp(t.start, 0, d), end: clamp(t.end, 0, d) })) };
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Output canvas size. `short` is the target height for landscape/original or width for portrait. */
export function canvasSize(p: Pick<EditProject, 'aspect' | 'source'>, resolution: 'original' | '1080p' | '720p'): { width: number; height: number } {
  const { width: sw, height: sh } = p.source;
  const srcShort = Math.min(sw, sh);
  const short = resolution === '1080p' ? Math.min(1080, srcShort) : resolution === '720p' ? Math.min(720, srcShort) : srcShort;
  switch (p.aspect) {
    case '16:9': return { width: even((short * 16) / 9), height: even(short) };
    case '9:16': return { width: even(short), height: even((short * 16) / 9) };
    case '1:1': return { width: even(short), height: even(short) };
    default: {
      const scale = short / srcShort;
      return { width: even(sw * scale), height: even(sh * scale) };
    }
  }
}

export function aspectRatio(p: Pick<EditProject, 'aspect' | 'source'>): number {
  const c = canvasSize(p, 'original');
  return c.width / c.height;
}

/** Source crop rectangle (pixels) that fills the output canvas: cover-fit, then zoom and pan. */
export function cropRect(p: Pick<EditProject, 'aspect' | 'source' | 'framing'>): { x: number; y: number; w: number; h: number } {
  const { width: sw, height: sh } = p.source;
  const ar = aspectRatio(p);
  let baseW = Math.min(sw, sh * ar);
  let baseH = baseW / ar;
  if (baseH > sh) { baseH = sh; baseW = sh * ar; }
  const zoom = clamp(p.framing.zoom, 1, 5);
  const w = baseW / zoom, h = baseH / zoom;
  const x = ((sw - w) / 2) * (1 + clamp(p.framing.offsetX, -1, 1));
  const y = ((sh - h) / 2) * (1 + clamp(p.framing.offsetY, -1, 1));
  const ew = even(w), eh = even(h);
  return { x: clamp(Math.round(x), 0, Math.max(0, sw - ew)), y: clamp(Math.round(y), 0, Math.max(0, sh - eh)), w: ew, h: eh };
}

export function validateProject(p: unknown): p is EditProject {
  const q = p as EditProject;
  const finite = (...v: unknown[]) => v.every((n) => Number.isFinite(n));
  return !!q && q.version === 1 && Array.isArray(q.segments) && q.segments.length > 0 &&
    q.segments.every((s) => !!s && finite(s.start, s.end) && s.end > s.start) &&
    typeof q.source?.path === 'string' && finite(q.source.duration, q.source.width, q.source.height) &&
    finite(q.framing?.zoom, q.framing?.offsetX, q.framing?.offsetY) &&
    finite(q.audio?.desktopVolume, q.audio?.micVolume) &&
    Array.isArray(q.texts) && q.texts.every((t) => !!t && typeof t.text === 'string');
}
