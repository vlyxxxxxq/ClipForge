import path from 'node:path';
import { readJson, writeJsonAtomic } from './util';
import { REPLAY_DURATIONS, Settings } from '../shared/types';

export function defaultSettings(videosDir: string): Settings {
  return {
    capture: {
      replayDuration: 60, hotkey: 'F8', monitorIndex: 0, resolution: '1080p', fps: 60, quality: 'high', encoder: 'auto',
      desktopAudio: true, desktopDeviceId: null, micEnabled: false, micDeviceId: null, desktopVolume: 1, micVolume: 1,
      clipsDir: path.join(videosDir, 'ClipForge'), autoStartCapture: false,
    },
    general: { closeToTray: true, notifyOnSave: true, launchMinimized: false },
  };
}

const oneOf = <T>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string | null) => (typeof v === 'string' && v.length < 1024 ? v : d);

/** Merge untrusted input (from disk or the renderer) onto defaults, validating every field. */
export function sanitizeSettings(input: any, d: Settings): Settings {
  const c = input?.capture ?? {}, g = input?.general ?? {};
  const dc = d.capture;
  return {
    capture: {
      replayDuration: oneOf(c.replayDuration, REPLAY_DURATIONS, dc.replayDuration),
      hotkey: typeof c.hotkey === 'string' && /^[\w+]{1,40}$/.test(c.hotkey) ? c.hotkey : dc.hotkey,
      monitorIndex: Math.round(num(c.monitorIndex, 0, 15, dc.monitorIndex)),
      resolution: oneOf(c.resolution, ['native', '1440p', '1080p', '720p'] as const, dc.resolution),
      fps: oneOf(c.fps, [30, 60] as const, dc.fps),
      quality: oneOf(c.quality, ['low', 'medium', 'high', 'ultra'] as const, dc.quality),
      encoder: oneOf(c.encoder, ['auto', 'h264_amf', 'h264_nvenc', 'h264_qsv', 'libx264'] as const, dc.encoder),
      desktopAudio: bool(c.desktopAudio, dc.desktopAudio),
      desktopDeviceId: str(c.desktopDeviceId, null),
      micEnabled: bool(c.micEnabled, dc.micEnabled),
      micDeviceId: str(c.micDeviceId, null),
      desktopVolume: num(c.desktopVolume, 0, 2, 1),
      micVolume: num(c.micVolume, 0, 2, 1),
      clipsDir: typeof c.clipsDir === 'string' && path.isAbsolute(c.clipsDir) ? c.clipsDir : dc.clipsDir,
      autoStartCapture: bool(c.autoStartCapture, dc.autoStartCapture),
    },
    general: {
      closeToTray: bool(g.closeToTray, d.general.closeToTray),
      notifyOnSave: bool(g.notifyOnSave, d.general.notifyOnSave),
      launchMinimized: bool(g.launchMinimized, d.general.launchMinimized),
    },
  };
}

export class SettingsStore {
  private value: Settings;
  constructor(private file: string, private defaults: Settings) {
    this.value = sanitizeSettings(readJson(file, {}), defaults);
  }
  get(): Settings { return structuredClone(this.value); }
  set(next: unknown): Settings {
    this.value = sanitizeSettings(next, this.defaults);
    writeJsonAtomic(this.file, this.value);
    return this.get();
  }
}
