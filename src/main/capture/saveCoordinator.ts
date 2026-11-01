// Turns hotkey presses into clips. History is reserved the moment a press is accepted, so a queued
// save keeps its footage through expiry, pause, stop and restart. Saves are written one at a time.
import { BufferSegment, composeSave, ReplayBuffer } from './replayBuffer';

export interface SavedClip {
  file: string;
  durationSec: number;
  audioTracks: string[];
  pressSec?: number; // estimated position of the press inside the clip (within about half a second)
}
export type ClipPath = (ext: string) => string;

export const MAX_PENDING_SAVES = 4;
const PRESS_DEBOUNCE_MS = 1000;

export interface SaveDeps {
  buffer: ReplayBuffer;
  session: () => number;
  /** True while ffmpeg is writing a segment that the press falls inside. */
  capturing: () => boolean;
  write: (segs: BufferSegment[], tracks: string[], clipPath: ClipPath) => Promise<SavedClip>;
  onPendingChange: (pending: number) => void;
  /** Called after a save releases its segments, so they can be cleaned up. */
  released: () => void;
  segmentTimeoutMs: number;
  now?: () => number;
}

export class SaveCoordinator {
  private lastPress = -Infinity;
  private pending = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private waiters = new Set<() => void>();

  constructor(private deps: SaveDeps) {}

  /** Resolves with the clip, or null when the press was ignored as a repeat. */
  request(duration: number, tracks: string[], clipPath: ClipPath): Promise<SavedClip | null> {
    const { buffer } = this.deps;
    const clock = this.deps.now ?? Date.now;
    const now = clock();
    if (now - this.lastPress < PRESS_DEBOUNCE_MS) return Promise.resolve(null);
    if (this.pending >= MAX_PENDING_SAVES) return Promise.reject(new Error('Too many clips are being saved. Try again in a moment.'));
    this.lastPress = now;

    const session = this.deps.session();
    const reserved = buffer.select(duration, Infinity, session);
    buffer.pin(reserved);
    let closing: BufferSegment | null = null;
    let afterPress = 0; // seconds of footage the clip holds after the press
    const closed = this.deps.capturing()
      ? this.waitForClosing(buffer.totalAdded, session).then((s) => { closing = s; if (s) afterPress = (clock() - now) / 1000; })
      : Promise.resolve();
    const snapshot = [...tracks];
    this.setPending(this.pending + 1);

    const job = this.chain.then(async () => {
      await closed;
      const segs = composeSave(reserved, closing, duration);
      if (!segs.length) throw new Error('The replay buffer is empty — wait a few seconds after starting capture.');
      const clip = await this.deps.write(segs, snapshot, clipPath);
      return { ...clip, pressSec: Math.max(0, clip.durationSec - afterPress) };
    }).finally(() => {
      buffer.unpin(reserved);
      if (closing) buffer.unpin([closing]);
      this.setPending(this.pending - 1);
      this.deps.released();
    });
    this.chain = job.catch(() => {});
    return job;
  }

  /** Call after new segments are added to the buffer. */
  segmentAdded() { for (const check of [...this.waiters]) check(); }

  /** Call when ffmpeg exits: no more segments are coming, so nothing should keep waiting. */
  captureEnded() { for (const check of [...this.waiters]) check(); }

  /** Resolves once every accepted save has finished. */
  async drain() {
    let current;
    do { current = this.chain; await current; } while (current !== this.chain);
  }

  private setPending(n: number) { this.pending = n; this.deps.onPendingChange(n); }

  /** The segment being written at the press, pinned as soon as it closes; null if it never does. */
  private waitForClosing(seq: number, session: number): Promise<BufferSegment | null> {
    const { buffer } = this.deps;
    return new Promise((resolve) => {
      const finish = () => {
        this.waiters.delete(check);
        clearTimeout(timer);
        const seg = buffer.find(seq, session);
        if (seg) buffer.pin([seg]);
        resolve(seg);
      };
      const check = () => { if (buffer.totalAdded > seq || !this.deps.capturing() || this.deps.session() !== session) finish(); };
      const timer = setTimeout(finish, this.deps.segmentTimeoutMs);
      this.waiters.add(check);
    });
  }
}
