import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncedSaver } from './debouncedSaver';

describe('createDebouncedSaver', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('saves only the newest value after a quiet period', () => {
    const save = vi.fn(async () => {});
    const s = createDebouncedSaver<number>(save, 500, () => {});
    s.schedule(1);
    vi.advanceTimersByTime(300);
    s.schedule(2);
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save.mock.calls).toEqual([[2]]);
  });

  it('flush saves an edit made just before leaving the page, exactly once', () => {
    const save = vi.fn(async () => {});
    const s = createDebouncedSaver<string>(save, 500, () => {});
    s.schedule('last edit');
    vi.advanceTimersByTime(100);
    s.flush();
    expect(save.mock.calls).toEqual([['last edit']]);
    vi.advanceTimersByTime(1000);
    s.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('reports a failed save', async () => {
    const onError = vi.fn();
    const s = createDebouncedSaver<number>(() => Promise.reject(new Error('disk full')), 500, onError);
    s.schedule(1);
    s.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError.mock.calls[0][0].message).toBe('disk full');
  });
});
