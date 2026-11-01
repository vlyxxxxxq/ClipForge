// Save cues, generated with oscillators so no audio files are needed. A cue only ever follows a real outcome.
import type { AppEvent } from '../shared/types';

export type Cue = 'success' | 'failure';

export function cueForEvent(e: Pick<AppEvent, 'type'>): Cue | null {
  if (e.type === 'clip-saved' || e.type === 'screenshot-saved') return 'success';
  if (e.type === 'clip-save-failed' || e.type === 'screenshot-failed') return 'failure';
  return null;
}

const NOTES: Record<Cue, { hz: number; at: number; len: number }[]> = {
  success: [{ hz: 660, at: 0, len: 0.09 }, { hz: 990, at: 0.08, len: 0.14 }],
  failure: [{ hz: 300, at: 0, len: 0.14 }, { hz: 200, at: 0.13, len: 0.2 }],
};

let ctx: AudioContext | null = null;

export function playCue(cue: Cue) {
  ctx ??= new AudioContext();
  const start = ctx.currentTime + 0.01;
  for (const n of NOTES[cue]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.hz;
    gain.gain.setValueAtTime(0.0001, start + n.at);
    gain.gain.exponentialRampToValueAtTime(0.18, start + n.at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.at + n.len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + n.at);
    osc.stop(start + n.at + n.len + 0.02);
  }
}
