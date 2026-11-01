import { describe, expect, it } from 'vitest';
import { canvasSize, createProject, cropRect, outputDuration, outputToSource, removeSegment, setTrimEnd, setTrimStart, sourceToOutput, splitAt, markerTimes, toggleMarker, validateProject } from './project';

const src = { path: 'C:/c.mp4', duration: 30, width: 1920, height: 1080, audioTracks: ['Desktop', 'Microphone'] };
const base = () => createProject('c1', src);

describe('edit project', () => {
  it('trims and maps time', () => {
    let p = setTrimEnd(setTrimStart(base(), 5), 25);
    expect(outputDuration(p)).toBe(20);
    expect(outputToSource(p, 0).time).toBe(5);
    expect(sourceToOutput(p, 10)).toBe(5);
    expect(sourceToOutput(p, 2)).toBeNull();
  });

  it('splits and removes a section', () => {
    let p = splitAt(base(), 10);
    p = splitAt(p, 20);
    expect(p.segments.map((s) => [s.start, s.end])).toEqual([[0, 10], [10, 20], [20, 30]]);
    p = removeSegment(p, p.segments[1].id);
    expect(outputDuration(p)).toBe(20);
    expect(outputToSource(p, 12).time).toBe(22);
    expect(sourceToOutput(p, 15)).toBeNull();
  });

  it('ignores splits at boundaries and never removes the last segment', () => {
    const p = base();
    expect(splitAt(p, 0.01)).toBe(p);
    expect(removeSegment(p, p.segments[0].id)).toBe(p);
  });

  it('clamps text overlays when duration shrinks', () => {
    const p = { ...base(), texts: [{ id: 't', text: 'hi', x: 0.5, y: 0.5, size: 0.08, color: '#fff', start: 20, end: 29 }] };
    const q = setTrimEnd(p, 15);
    expect(q.texts[0].start).toBe(15);
    expect(q.texts[0].end).toBe(15);
  });

  it('computes canvas sizes per aspect and resolution', () => {
    expect(canvasSize({ ...base(), aspect: '9:16' }, '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(canvasSize({ ...base(), aspect: '9:16' }, '720p')).toEqual({ width: 720, height: 1280 });
    expect(canvasSize({ ...base(), aspect: '1:1' }, 'original')).toEqual({ width: 1080, height: 1080 });
    expect(canvasSize({ ...base(), aspect: 'original' }, '720p')).toEqual({ width: 1280, height: 720 });
    expect(canvasSize({ ...base(), source: { ...src, width: 2560, height: 1440 }, aspect: '16:9' }, 'original')).toEqual({ width: 2560, height: 1440 });
  });

  it('crops a centered vertical slice, with zoom and pan clamped to the frame', () => {
    const p = { ...base(), aspect: '9:16' as const };
    expect(cropRect(p)).toEqual({ x: 656, y: 0, w: 608, h: 1080 });
    const left = cropRect({ ...p, framing: { zoom: 1, offsetX: -1, offsetY: 0 } });
    expect(left.x).toBe(0);
    const z = cropRect({ ...p, framing: { zoom: 2, offsetX: 1, offsetY: 1 } });
    expect(z.w).toBe(304);
    expect(z.x + z.w).toBeLessThanOrEqual(1920);
    expect(z.y + z.h).toBeLessThanOrEqual(1080);
  });

  it('validates persisted projects', () => {
    expect(validateProject(base())).toBe(true);
    expect(validateProject({ ...base(), segments: [] })).toBe(false);
    expect(validateProject({ ...base(), segments: [{ id: 'x', start: 5, end: 2 }] })).toBe(false);
    expect(validateProject(null)).toBe(false);
  });
});

describe('cropRect at the edges', () => {
  it('stays inside the source at the far right of a portrait crop', () => {
    const p = createProject('c', { path: 'x', duration: 10, width: 1920, height: 1080, audioTracks: [] });
    const r = cropRect({ ...p, aspect: '9:16', framing: { zoom: 1, offsetX: 1, offsetY: 0 } });
    expect(r.x + r.w).toBeLessThanOrEqual(1920);
    expect(r.y + r.h).toBeLessThanOrEqual(1080);
  });
});

describe('validateProject', () => {
  const good = () => createProject('c', { path: 'x', duration: 10, width: 1920, height: 1080, audioTracks: [] });
  it('accepts a real project', () => { expect(validateProject(good())).toBe(true); });
  it.each([
    ['null segment', { segments: [null] }],
    ['missing audio', { audio: undefined }],
    ['missing framing', { framing: undefined }],
    ['non-finite zoom', { framing: { zoom: Infinity, offsetX: 0, offsetY: 0 } }],
    ['missing source size', { source: { path: 'x' } }],
    ['null text', { texts: [null] }],
  ])('rejects %s without throwing', (_name, patch) => { expect(validateProject({ ...good(), ...patch })).toBe(false); });
});

describe('markers', () => {
  it('toggles a marker on and off', () => {
    const on = toggleMarker(base(), 5);
    expect(on.markers).toEqual([5]);
    expect(toggleMarker(on, 5.1).markers).toEqual([]);
    expect(toggleMarker(on, 2).markers).toEqual([2, 5]);
  });

  it('follows the edit and drops markers in removed sections', () => {
    let p = toggleMarker(toggleMarker(base(), 12), 22);
    p = splitAt(splitAt(p, 10), 20);
    p = removeSegment(p, p.segments[1].id); // removes 10..20
    expect(markerTimes(p, 5)).toEqual([{ time: 5, press: true }, { time: 12, press: false }]);
    expect(validateProject(p)).toBe(true);
    expect(validateProject({ ...p, markers: [NaN] })).toBe(false);
  });
});
