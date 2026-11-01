import { describe, expect, it } from 'vitest';
import { clickSelection, dateLabel, groupByDate, runBatch } from './libraryView';

const now = new Date(2026, 10, 15, 12);
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).toISOString();

describe('date groups', () => {
  it('labels by calendar day, not by 24-hour periods', () => {
    expect(dateLabel(at(2026, 10, 15, 0), now)).toBe('Today');
    expect(dateLabel(at(2026, 10, 14, 23), now)).toBe('Yesterday');
    expect(dateLabel(at(2026, 10, 10), now)).toBe('This week');
    expect(dateLabel(at(2026, 9, 3), now)).toContain('2026');
  });

  it('keeps the sorted order and joins neighbors', () => {
    const clips = [at(2026, 10, 15), at(2026, 10, 15), at(2026, 10, 14), at(2026, 9, 1)].map((createdAt, i) => ({ createdAt, i }));
    const groups = groupByDate(clips, now);
    expect(groups.map((g) => g.clips.length)).toEqual([2, 1, 1]);
    expect(groups.flatMap((g) => g.clips).map((c) => c.i)).toEqual([0, 1, 2, 3]);
  });
});

describe('clickSelection', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const none = { checked: new Set<string>(), anchor: null };

  it('plain click selects one', () => {
    const s = clickSelection({ checked: new Set(['a', 'b']), anchor: 'a' }, 'c', ids, {});
    expect([...s.checked]).toEqual(['c']);
  });

  it('ctrl click toggles without losing the rest', () => {
    let s = clickSelection(none, 'a', ids, {});
    s = clickSelection(s, 'c', ids, { ctrl: true });
    expect([...s.checked].sort()).toEqual(['a', 'c']);
    s = clickSelection(s, 'a', ids, { ctrl: true });
    expect([...s.checked]).toEqual(['c']);
  });

  it('shift click selects a range in either direction', () => {
    const s = clickSelection(none, 'c', ids, {});
    expect([...clickSelection(s, 'a', ids, { shift: true }).checked].sort()).toEqual(['a', 'b', 'c']);
    expect([...clickSelection(s, 'd', ids, { shift: true }).checked].sort()).toEqual(['c', 'd']);
  });

  it('shift click ignores an anchor that is filtered out', () => {
    const s = clickSelection({ checked: new Set(['z']), anchor: 'z' }, 'b', ids, { shift: true });
    expect([...s.checked]).toEqual(['b']);
  });
});

describe('runBatch', () => {
  it('carries on after a failure and reports it', async () => {
    const seen: number[] = [];
    const r = await runBatch([1, 2, 3], async (n) => { seen.push(n); if (n === 2) throw new Error('locked'); });
    expect(seen).toEqual([1, 2, 3]);
    expect(r).toEqual({ done: 2, failed: ['locked'] });
  });
});
