// Decides which global shortcuts to register. A shortcut can only do one thing, so a duplicate is
// reported instead of silently replacing the other binding.
import type { CaptureSettings, ReplayDuration } from '../shared/types';
import { REPLAY_DURATIONS } from '../shared/types';

export const RETENTION_MARGIN_SEC = 6; // keep a little extra beyond the longest replay

export type HotkeyAction = { type: 'save'; duration: ReplayDuration | null } | { type: 'screenshot' };
export interface HotkeyBinding { accel: string; action: HotkeyAction; label: string }

export function planHotkeys(c: CaptureSettings): { bindings: HotkeyBinding[]; problems: string[] } {
  const wanted: HotkeyBinding[] = [{ accel: c.hotkey, action: { type: 'save', duration: null }, label: 'Save clip' }];
  for (const d of REPLAY_DURATIONS) {
    const accel = c.durationHotkeys[d];
    if (accel) wanted.push({ accel, action: { type: 'save', duration: d }, label: `Save last ${d}s` });
  }
  if (c.screenshotHotkey) wanted.push({ accel: c.screenshotHotkey, action: { type: 'screenshot' }, label: 'Screenshot' });

  const bindings: HotkeyBinding[] = [];
  const problems: string[] = [];
  for (const b of wanted) {
    const taken = bindings.find((x) => x.accel.toLowerCase() === b.accel.toLowerCase());
    if (taken) problems.push(`"${b.accel}" can't be used for ${b.label} because it's already set for ${taken.label}.`);
    else bindings.push(b);
  }
  return { bindings, problems };
}

/** How much footage to keep: enough for the longest save any hotkey can ask for. */
export function retentionFor(c: CaptureSettings): number {
  const bound = REPLAY_DURATIONS.filter((d) => c.durationHotkeys[d]);
  return Math.max(c.replayDuration, ...bound) + RETENTION_MARGIN_SEC;
}
