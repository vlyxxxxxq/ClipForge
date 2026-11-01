import { describe, expect, it } from 'vitest';
import { computePeaks, PEAKS_PER_SEC, waveformColumns } from './peaks';
import { createProject, removeSegment, splitAt } from './project';

const project = () => createProject('c', { path: 'x', duration: 30, width: 1920, height: 1080, audioTracks: ['Desktop'] });

describe('computePeaks', () => {
  it('finds the loudest sample in each bin, positive or negative', () => {
    expect(computePeaks(Int16Array.from([0, 16384, -32768, 0, 100]), 2)).toEqual([0.5, 1, 0.003]);
  });
});

describe('waveformColumns', () => {
  // Loud from 10 to 20 s, silent elsewhere.
  const peaks = Array.from({ length: 30 * PEAKS_PER_SEC }, (_, i) => (i >= 10 * PEAKS_PER_SEC && i < 20 * PEAKS_PER_SEC ? 1 : 0));

  it('maps columns to source time', () => {
    const c = waveformColumns(project(), peaks, 30);
    expect(c[5]).toBe(0);
    expect(c[15]).toBe(1);
    expect(c[25]).toBe(0);
  });

  it('follows a cut: removing the loud section leaves silence', () => {
    let p = splitAt(splitAt(project(), 10), 20);
    p = removeSegment(p, p.segments[1].id);
    expect(Math.max(...waveformColumns(p, peaks, 20).slice(0, 19))).toBe(0);
  });

  it('moves later audio earlier after a cut', () => {
    let p = splitAt(splitAt(project(), 5), 10);
    p = removeSegment(p, p.segments[1].id); // output is now 25 s; the loud part starts at 5 s
    const c = waveformColumns(p, peaks, 25);
    expect(c[3]).toBe(0);
    expect(c[7]).toBe(1);
    expect(c[20]).toBe(0);
  });

  it('copes with no audio data', () => {
    expect(waveformColumns(project(), [], 4)).toEqual([0, 0, 0, 0]);
  });
});
