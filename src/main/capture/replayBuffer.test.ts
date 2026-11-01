import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { concatScript, ReplayBuffer } from './replayBuffer';
import { buildCaptureArgs, buildSaveArgs, buildScreenshotArgs, targetSize } from './captureArgs';
import { defaultSettings } from '../settings';

const seg = (session: number, i: number, len = 2) => ({ session, file: `/b/s${session}/seg_${i}.ts`, start: i * len, end: (i + 1) * len });
function filled(n: number, session = 1, retention = 1000) {
  const b = new ReplayBuffer(retention);
  for (let i = 0; i < n; i++) b.add(seg(session, i));
  return b;
}

describe('ReplayBuffer', () => {
  it('parses ffmpeg segment list lines', () => {
    expect(ReplayBuffer.parseListLine('seg_000003.ts,6.000000,8.016667', 'D', 1, path.posix.join)).toEqual({ session: 1, file: 'D/seg_000003.ts', start: 6, end: 8.016667 });
    expect(ReplayBuffer.parseListLine('garbage', 'D', 1, path.posix.join)).toBeNull();
    expect(ReplayBuffer.parseListLine('a.ts,4,4', 'D', 1, path.posix.join)).toBeNull();
  });

  it('selects the newest segments covering the duration', () => {
    const sel = filled(40).select(30);
    expect(sel).toHaveLength(15);
    expect(sel[0].start).toBe(50);
    expect(sel[sel.length - 1].end).toBe(80);
  });

  it('returns what exists when the buffer is not yet full', () => {
    const sel = filled(4).select(60);
    expect(sel).toHaveLength(4);
    expect(sel[0].start).toBe(0);
  });

  it('honours upToSeq so a save ends at the segment containing the press, even after cleanup', () => {
    const b = filled(20, 1, 6);
    b.collectExpired(); // indices shift; seqs do not
    expect(b.select(4, 18).map((s) => s.seq)).toEqual([17, 18]);
    const sel = filled(20).select(10, 9);
    expect(sel[sel.length - 1].end).toBe(20);
    expect(sel).toHaveLength(5);
  });

  it('never spans sessions or gaps', () => {
    const b = filled(10, 1);
    b.add({ session: 2, file: '/b/s2/seg_0.ts', start: 0, end: 2 });
    b.add({ session: 2, file: '/b/s2/seg_1.ts', start: 2, end: 4 });
    expect(b.select(60).map((s) => s.session)).toEqual([2, 2]);
    const g = new ReplayBuffer(100);
    g.add(seg(1, 0)); g.add(seg(1, 1)); g.add(seg(1, 5)); g.add(seg(1, 6));
    expect(g.select(60)).toHaveLength(2);
  });

  it('expires segments beyond retention but keeps pinned ones', () => {
    const b = filled(30, 1, 20); // 60 s buffered, keep 20 s
    const pinned = b.select(60).slice(0, 3); // oldest three
    b.pin(pinned);
    const expired = b.collectExpired();
    expect(expired.map((s) => s.file)).not.toContain(pinned[0].file);
    expect(expired).toHaveLength(30 - 10 - 3);
    expect(b.count).toBe(13);
    b.unpin(pinned);
    expect(b.collectExpired()).toHaveLength(3);
    expect(b.bufferedSeconds()).toBe(20);
  });

  it('pin refcounts survive overlapping saves', () => {
    const b = filled(10, 1, 2);
    const s = b.select(20);
    b.pin(s); b.pin(s);
    b.unpin(s);
    expect(b.collectExpired()).toHaveLength(0);
    b.unpin(s);
    expect(b.collectExpired().length).toBeGreaterThan(0);
  });

  it('expires whole older sessions', () => {
    const b = filled(5, 1, 100);
    b.add({ session: 2, file: '/x/a.ts', start: 0, end: 2 });
    expect(b.collectExpired()).toHaveLength(5);
  });

  it('clear() leaves pinned segments', () => {
    const b = filled(5);
    b.pin([b.all()[0]]);
    expect(b.clear()).toHaveLength(4);
    expect(b.count).toBe(1);
  });

  it('writes a quoted concat script', () => {
    const s = concatScript([{ session: 1, file: "C:\\Users\\o'neil\\seg.ts", start: 0, end: 2 }]);
    expect(s).toContain("file 'C:/Users/o'\\''neil/seg.ts'");
  });
});

describe('capture args', () => {
  const s = defaultSettings('/videos').capture;
  it('scales to the target resolution and keeps aspect', () => {
    expect(targetSize({ ...s, resolution: '1080p' }, 2560, 1440)).toEqual({ w: 1920, h: 1080 });
    expect(targetSize({ ...s, resolution: '1440p' }, 1920, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(targetSize({ ...s, resolution: '720p' }, 3440, 1440)).toEqual({ w: 1720, h: 720 });
  });
  it('forces keyframes on segment boundaries and maps each audio pipe', () => {
    const a = buildCaptureArgs({ settings: s, encoder: 'h264_amf', sourceWidth: 2560, sourceHeight: 1440, segmentDir: '/seg', join: path.posix.join,
      audioPipes: [{ pipe: 'p1', title: 'Desktop', volume: 1 }, { pipe: 'p2', title: 'Microphone', volume: 0.5 }] });
    expect(a).toContain('\\\\.\\pipe\\p1');
    expect(a[a.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*2)');
    expect(a[a.indexOf('-forced_idr') + 1]).toBe('1');
    expect(a.filter((x) => x === '-map')).toHaveLength(3);
    expect(a.join(' ')).toContain('[1:a]volume=0.50');
    expect(a[a.length - 1]).toBe('/seg/seg_%06d.ts');
  });
  it('save args remux without re-encoding into faststart MP4', () => {
    const a = buildSaveArgs('/l.ffconcat', '/o.mp4', ['Desktop']);
    expect(a).toEqual(expect.arrayContaining(['-c', 'copy', '+faststart', 'title=Desktop']));
  });
});

describe('buildScreenshotArgs', () => {
  it('captures one frame of the chosen display', () => {
    const a = buildScreenshotArgs(2, 'C:/out.png');
    expect(a[a.indexOf('-i') + 1]).toContain('output_idx=2');
    expect(a.slice(-3)).toEqual(['-frames:v', '1', 'C:/out.png']);
  });
});
