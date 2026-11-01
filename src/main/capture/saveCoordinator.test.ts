import { describe, expect, it } from 'vitest';
import { BufferSegment, ReplayBuffer } from './replayBuffer';
import { MAX_PENDING_SAVES, SaveCoordinator, SavedClip } from './saveCoordinator';

const seg = (session: number, i: number) => ({ session, file: `/b/s${session}/seg_${i}.ts`, start: i * 2, end: (i + 1) * 2 });

function setup(opts: { retention?: number; timeoutMs?: number } = {}) {
  const buffer = new ReplayBuffer(opts.retention ?? 20);
  const state = { session: 1, capturing: true, time: 0, pending: 0, deleted: [] as string[], releases: [] as (() => void)[], written: [] as BufferSegment[][], hold: false };
  const cleanup = () => state.deleted.push(...buffer.collectExpired().map((s) => s.file));
  const saves = new SaveCoordinator({
    buffer,
    session: () => state.session,
    capturing: () => state.capturing,
    write: async (segs): Promise<SavedClip> => {
      if (state.hold) await new Promise<void>((r) => state.releases.push(r));
      for (const s of segs) if (state.deleted.includes(s.file)) throw new Error('segment deleted before write: ' + s.file);
      state.written.push(segs);
      return { file: 'clip.mp4', durationSec: segs.length * 2, audioTracks: [] };
    },
    onPendingChange: (n) => { state.pending = n; },
    released: cleanup,
    segmentTimeoutMs: opts.timeoutMs ?? 50,
    now: () => state.time,
  });
  const add = (session: number, from: number, to: number) => {
    for (let i = from; i < to; i++) { buffer.add(seg(session, i)); cleanup(); saves.segmentAdded(); }
  };
  return { buffer, state, saves, add };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SaveCoordinator', () => {
  it('saves the requested history plus the segment being written at the press', async () => {
    const { saves, add, state } = setup();
    add(1, 0, 10);
    const p = saves.request(10, [], () => 'x');
    add(1, 10, 11);
    expect(await p).not.toBeNull();
    expect(state.written[0].map((s) => s.start)).toEqual([12, 14, 16, 18, 20]);
    expect(state.pending).toBe(0);
  });

  it('works out where in the clip the press happened', async () => {
    const { saves, add, state } = setup();
    add(1, 0, 10);
    const p = saves.request(10, [], () => 'x');
    state.time += 1500;
    add(1, 10, 11);
    const clip = await p;
    expect(clip!.durationSec).toBe(10);
    expect(clip!.pressSec).toBeCloseTo(8.5);
  });

  it('puts the press at the end of a clip saved while paused', async () => {
    const { saves, add, state } = setup();
    add(1, 0, 5);
    state.capturing = false;
    const clip = await saves.request(4, [], () => 'x');
    expect(clip!.pressSec).toBe(clip!.durationSec);
  });

  it('keeps a queued save\'s history while an earlier save is slow', async () => {
    const { saves, add, state, buffer } = setup({ retention: 10 });
    add(1, 0, 10);
    state.hold = true;
    const a = saves.request(10, [], () => 'a');
    add(1, 10, 11);
    state.time = 2000;
    const b = saves.request(10, [], () => 'b');
    add(1, 11, 40); // far beyond retention while A is still writing
    await tick();
    state.releases.shift()!();
    await a;
    await tick();
    state.releases.shift()!();
    await b;
    // B's clip ends with the segment being written at its press (seq 11) and has its full history.
    expect(state.written[1].map((s) => s.start)).toEqual([14, 16, 18, 20, 22]);
    expect(state.pending).toBe(0);
    add(1, 40, 60);
    expect(buffer.isPinned(state.written[1][0].file)).toBe(false);
    expect(state.deleted).toContain(state.written[1][0].file);
  });

  it('never uses a new session\'s segment that reuses the press sequence', async () => {
    const { saves, add, state } = setup();
    add(1, 0, 5);
    const p = saves.request(10, [], () => 'x');
    state.session = 2; // ffmpeg died before closing its segment and capture restarted
    add(2, 0, 3);
    await p;
    expect(state.written[0].every((s) => s.session === 1)).toBe(true);
    expect(state.written[0].map((s) => s.start)).toEqual([0, 2, 4, 6, 8]);
  });

  it('finishes straight away when capture ends during the wait', async () => {
    const { saves, add, state } = setup({ timeoutMs: 60000 });
    add(1, 0, 3);
    const p = saves.request(4, [], () => 'x');
    state.capturing = false;
    saves.captureEnded();
    await p;
    expect(state.written[0].map((s) => s.start)).toEqual([2, 4]);
  });

  it('survives a stop that clears the buffer while a save is waiting', async () => {
    const { saves, add, state, buffer } = setup();
    add(1, 0, 5);
    const p = saves.request(10, [], () => 'x');
    add(1, 5, 6);
    const removed = buffer.clear().map((s) => s.file);
    await p;
    for (const s of state.written[0]) expect(removed).not.toContain(s.file);
  });

  it('ignores repeated presses and rejects overflow, then recovers', async () => {
    const { saves, add, state } = setup();
    add(1, 0, 5);
    state.capturing = false;
    state.hold = true;
    const jobs = [saves.request(4, [], () => '0')];
    expect(await saves.request(4, [], () => 'r')).toBeNull();
    for (let i = 1; i < MAX_PENDING_SAVES; i++) { state.time += 1000; jobs.push(saves.request(4, [], () => String(i))); }
    state.time += 1000;
    await expect(saves.request(4, [], () => 'over')).rejects.toThrow(/Too many/);
    expect(state.pending).toBe(MAX_PENDING_SAVES);
    for (let i = 0; i < 8; i++) { state.releases.splice(0).forEach((r) => r()); await tick(); }
    await Promise.all(jobs);
    expect(state.pending).toBe(0);
    state.hold = false;
    state.time += 1000;
    expect(await saves.request(4, [], () => 'after')).not.toBeNull();
  });

  it('releases its segments when writing fails, and the queue carries on', async () => {
    const { add, state, buffer } = setup();
    const failing = new SaveCoordinator({
      buffer, session: () => 1, capturing: () => false, onPendingChange: (n) => { state.pending = n; }, released: () => {}, segmentTimeoutMs: 50, now: () => state.time,
      write: async (segs) => { if (state.time === 0) throw new Error('disk full'); return { file: 'ok', durationSec: segs.length, audioTracks: [] }; },
    });
    add(1, 0, 3);
    await expect(failing.request(4, [], () => 'x')).rejects.toThrow('disk full');
    expect(buffer.isPinned('/b/s1/seg_2.ts')).toBe(false);
    state.time = 2000;
    await expect(failing.request(4, [], () => 'y')).resolves.not.toBeNull();
    expect(state.pending).toBe(0);
  });

  it('drain waits for every accepted save', async () => {
    const { saves, add, state } = setup();
    add(1, 0, 3);
    state.capturing = false;
    state.hold = true;
    const p = saves.request(4, [], () => 'x');
    let drained = false;
    const d = saves.drain().then(() => { drained = true; });
    await tick(); await tick();
    expect(drained).toBe(false);
    state.releases.shift()!();
    await p; await d;
    expect(drained).toBe(true);
  });
});
