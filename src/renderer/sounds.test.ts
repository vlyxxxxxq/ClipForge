import { describe, expect, it } from 'vitest';
import { cueForEvent } from './sounds';

describe('cueForEvent', () => {
  it('only plays after a real outcome', () => {
    expect(cueForEvent({ type: 'clip-saved' })).toBe('success');
    expect(cueForEvent({ type: 'screenshot-saved' })).toBe('success');
    expect(cueForEvent({ type: 'clip-save-failed' })).toBe('failure');
    expect(cueForEvent({ type: 'screenshot-failed' })).toBe('failure');
    expect(cueForEvent({ type: 'capture-interrupted' })).toBe('failure');
    expect(cueForEvent({ type: 'library-changed' })).toBeNull();
    expect(cueForEvent({ type: 'export' })).toBeNull();
  });
});
