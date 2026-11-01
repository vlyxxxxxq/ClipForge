import { describe, expect, it } from 'vitest';
import { planHotkeys, retentionFor } from './hotkeys';
import { defaultSettings } from './settings';

const capture = (patch = {}) => ({ ...defaultSettings('C:\\V').capture, ...patch });

describe('planHotkeys', () => {
  it('binds the main hotkey, each duration and the screenshot', () => {
    const { bindings, problems } = planHotkeys(capture({ durationHotkeys: { 15: 'F9', 120: 'Alt+F9' }, screenshotHotkey: 'F10' }));
    expect(problems).toEqual([]);
    expect(bindings.map((b) => [b.accel, b.action])).toEqual([
      ['F8', { type: 'save', duration: null }],
      ['F9', { type: 'save', duration: 15 }],
      ['Alt+F9', { type: 'save', duration: 120 }],
      ['F10', { type: 'screenshot' }],
    ]);
  });

  it('reports a duplicate and keeps the first binding working', () => {
    const { bindings, problems } = planHotkeys(capture({ durationHotkeys: { 30: 'f8', 60: 'F9' }, screenshotHotkey: 'F9' }));
    expect(bindings.map((b) => b.accel)).toEqual(['F8', 'F9']);
    expect(bindings[1].action).toEqual({ type: 'save', duration: 60 });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('Save last 30s');
    expect(problems[1]).toContain('Screenshot');
  });
});

describe('retentionFor', () => {
  it('covers the longest bound duration, not just the replay length', () => {
    expect(retentionFor(capture({ replayDuration: 15 }))).toBe(21);
    expect(retentionFor(capture({ replayDuration: 15, durationHotkeys: { 120: 'F9' } }))).toBe(126);
    expect(retentionFor(capture({ replayDuration: 90, durationHotkeys: { 30: 'F9' } }))).toBe(96);
  });
});
