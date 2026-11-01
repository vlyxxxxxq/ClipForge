import path from 'node:path';
import { loadDocument, writeJsonWithBackup } from './util';
import { REPLAY_DURATIONS, Settings } from '../shared/types';

export function defaultSettings(videosDir: string): Settings {
  return {
    capture: {
      replayDuration: 60, hotkey: 'F8', durationHotkeys: {}, screenshotHotkey: null, monitorIndex: 0, resolution: '1080p', fps: 60, quality: 'high', encoder: 'auto',
      desktopAudio: true, desktopDeviceId: null, micEnabled: false, micDeviceId: null, desktopVolume: 1, micVolume: 1,
      clipsDir: path.join(videosDir, 'ClipForge'), autoStartCapture: false,
    },
    general: { closeToTray: true, notifyOnSave: true, launchMinimized: false, saveSound: false },
  };
}

const oneOf = <T>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string | null) => (typeof v === 'string' && v.length < 1024 ? v : d);
const isAccel = (v: unknown): v is string => typeof v === 'string' && /^[\w+]{1,40}$/.test(v);

/** Merge untrusted input (from disk or the renderer) onto defaults, validating every field. */
export function sanitizeSettings(input: any, d: Settings): Settings {
  const c = input?.capture ?? {}, g = input?.general ?? {};
  const dc = d.capture;
  return {
    capture: {
      replayDuration: oneOf(c.replayDuration, REPLAY_DURATIONS, dc.replayDuration),
      hotkey: isAccel(c.hotkey) ? c.hotkey : dc.hotkey,
      durationHotkeys: Object.fromEntries(REPLAY_DURATIONS.filter((d) => isAccel(c.durationHotkeys?.[d])).map((d) => [d, c.durationHotkeys[d]])),
      screenshotHotkey: isAccel(c.screenshotHotkey) ? c.screenshotHotkey : null,
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
      saveSound: bool(g.saveSound, d.general.saveSound),
    },
  };
}

export class SettingsStore {
  private value: Settings;
  readonly notice: string | null;
  constructor(private file: string, private defaults: Settings) {
    const doc = loadDocument<object>(file, 'settings', null, (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null));
    this.notice = doc.notice;
    this.value = sanitizeSettings(doc.value ?? {}, defaults);
  }
  get(): Settings { return structuredClone(this.value); }
  set(next: unknown): Settings {
    const value = sanitizeSettings(next, this.defaults);
    writeJsonWithBackup(this.file, value); // on failure the settings in effect stay unchanged
    this.value = value;
    return this.get();
  }
}
