import { describe, expect, it } from 'vitest';
import { EXPORT_PRESETS, presetMatches } from './exportPresets';
import { canvasSize, createProject } from './project';

const source = { path: 'x', duration: 10, width: 2560, height: 1440, audioTracks: [] };
const get = (id: string) => EXPORT_PRESETS.find((x) => x.id === id)!;
const applied = (id: string) => {
  const pre = get(id);
  const p = { ...createProject('c', source), aspect: pre.aspect ?? '16:9' as const };
  return { p, size: canvasSize(p, pre.resolution) };
};

describe('export presets', () => {
  it('produce the promised output sizes', () => {
    expect(applied('landscape').size).toEqual({ width: 1920, height: 1080 });
    expect(applied('vertical').size).toEqual({ width: 1080, height: 1920 });
    expect(applied('square').size).toEqual({ width: 1080, height: 1080 });
    expect(applied('small').size).toEqual({ width: 1280, height: 720 });
  });

  it('are recognized only when everything matches', () => {
    const v = get('vertical');
    const opts = { resolution: v.resolution, fps: v.fps, quality: v.quality, fileName: 'a' };
    expect(presetMatches(v, { aspect: '9:16' }, opts)).toBe(true);
    expect(presetMatches(v, { aspect: '16:9' }, opts)).toBe(false);
    expect(presetMatches(v, { aspect: '9:16' }, { ...opts, quality: 'low' })).toBe(false);
  });
});
