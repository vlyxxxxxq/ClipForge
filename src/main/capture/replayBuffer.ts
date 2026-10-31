// Pure replay-buffer bookkeeping: segment tracking, clip selection, pinning and cleanup decisions.
// The CaptureService feeds it segment-list lines from ffmpeg and performs the actual file I/O.

export interface BufferSegment {
  session: number;
  file: string; // absolute path
  start: number; // pts seconds within its session
  end: number;
  seq?: number; // monotonic sequence assigned by add()
}

export class ReplayBuffer {
  private segments: BufferSegment[] = [];
  private pins = new Map<string, number>(); // file -> refcount
  private nextSeq = 0;

  constructor(private retentionSec: number) {}

  setRetention(sec: number) { this.retentionSec = sec; }

  /** Parse one CSV line of ffmpeg's segment list: "name.ts,start,end". */
  static parseListLine(line: string, dir: string, session: number, join: (a: string, b: string) => string): BufferSegment | null {
    const m = /^(.+?),(-?[\d.]+),(-?[\d.]+)\s*$/.exec(line.trim());
    if (!m) return null;
    const start = Number(m[2]), end = Number(m[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { session, file: join(dir, m[1]), start, end };
  }

  add(seg: BufferSegment) { this.segments.push({ ...seg, seq: this.nextSeq++ }); }

  /** Number of segments ever added; unaffected by cleanup. */
  get totalAdded() { return this.nextSeq; }

  all(): readonly BufferSegment[] { return this.segments; }
  get count() { return this.segments.length; }

  /** Seconds of contiguous buffered capture in the latest session. */
  bufferedSeconds(): number {
    const last = this.segments[this.segments.length - 1];
    if (!last) return 0;
    return this.segments.filter((s) => s.session === last.session).reduce((a, s) => a + (s.end - s.start), 0);
  }

  /**
   * Choose the newest contiguous segments of one session covering at least `duration` seconds,
   * ending with the newest segment whose seq <= `upToSeq` (defaults to the newest). Returns fewer if the
   * buffer is not yet full. Segments never span sessions, because a pause/restart breaks continuity.
   */
  select(duration: number, upToSeq = Infinity): BufferSegment[] {
    const out: BufferSegment[] = [];
    let upToIndex = this.segments.length - 1;
    while (upToIndex >= 0 && (this.segments[upToIndex].seq ?? 0) > upToSeq) upToIndex--;
    const endSeg = this.segments[upToIndex];
    if (!endSeg) return out;
    let total = 0;
    for (let i = upToIndex; i >= 0 && total < duration - 1e-3; i--) {
      const s = this.segments[i];
      if (s.session !== endSeg.session) break;
      const next = out[0];
      if (next && Math.abs(next.start - s.end) > 0.5) break; // gap: stop at discontinuity
      out.unshift(s);
      total += s.end - s.start;
    }
    return out;
  }

  pin(segs: BufferSegment[]) { for (const s of segs) this.pins.set(s.file, (this.pins.get(s.file) ?? 0) + 1); }
  unpin(segs: BufferSegment[]) {
    for (const s of segs) {
      const n = (this.pins.get(s.file) ?? 0) - 1;
      if (n <= 0) this.pins.delete(s.file); else this.pins.set(s.file, n);
    }
  }
  isPinned(file: string) { return (this.pins.get(file) ?? 0) > 0; }

  /**
   * Remove and return segments that fall outside the retention window (measured back from the
   * newest segment end) and are not pinned by an in-progress save. Older sessions expire too.
   */
  collectExpired(): BufferSegment[] {
    if (this.segments.length === 0) return [];
    const newest = this.segments[this.segments.length - 1];
    let keepFrom = this.segments.length;
    let total = 0;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i];
      if (s.session !== newest.session || total >= this.retentionSec) break;
      total += s.end - s.start;
      keepFrom = i;
    }
    const expired: BufferSegment[] = [];
    const kept: BufferSegment[] = [];
    this.segments.forEach((s, i) => {
      if (i < keepFrom && !this.isPinned(s.file)) expired.push(s); else kept.push(s);
    });
    this.segments = kept;
    return expired;
  }

  clear(): BufferSegment[] {
    const removable = this.segments.filter((s) => !this.isPinned(s.file));
    this.segments = this.segments.filter((s) => this.isPinned(s.file));
    return removable;
  }
}

/** Build an ffconcat script for the selected segments. Paths are quoted per the concat demuxer. */
export function concatScript(segs: BufferSegment[]): string {
  const esc = (p: string) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  return 'ffconcat version 1.0\n' + segs.map((s) => `file '${esc(s.file)}'\n`).join('');
}
