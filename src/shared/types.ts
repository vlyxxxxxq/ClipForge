// Types shared between the main process and the renderer.

export const REPLAY_DURATIONS = [15, 30, 60, 90, 120] as const;
export type ReplayDuration = (typeof REPLAY_DURATIONS)[number];

export type EncoderId = 'auto' | 'h264_amf' | 'h264_nvenc' | 'h264_qsv' | 'libx264';
export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface CaptureSettings {
  replayDuration: ReplayDuration;
  hotkey: string; // Electron accelerator, e.g. "F8"; saves the replay length above
  durationHotkeys: Partial<Record<ReplayDuration, string>>; // optional shortcuts for a fixed length
  screenshotHotkey: string | null;
  monitorIndex: number; // DXGI output index
  resolution: 'native' | '1440p' | '1080p' | '720p';
  fps: 30 | 60;
  quality: Quality;
  encoder: EncoderId;
  desktopAudio: boolean;
  desktopDeviceId: string | null; // null = system default
  micEnabled: boolean;
  micDeviceId: string | null;
  desktopVolume: number; // 0..2 applied at capture time
  micVolume: number;
  clipsDir: string;
  autoStartCapture: boolean;
}

export interface GeneralSettings {
  closeToTray: boolean;
  notifyOnSave: boolean;
  launchMinimized: boolean;
  saveSound: boolean;
  setupDone: boolean; // the first-run setup has been finished or skipped
}

export interface Settings {
  capture: CaptureSettings;
  general: GeneralSettings;
}

export type CaptureStateName = 'stopped' | 'starting' | 'recording' | 'paused' | 'error';

export interface CaptureStatus {
  state: CaptureStateName;
  bufferedSeconds: number;
  replayDuration: number;
  encoder: string | null; // encoder actually in use
  encoderFallbackReason: string | null;
  fps: number | null; // measured by ffmpeg
  droppedFrames: number;
  speed: number | null;
  hotkey: string;
  hotkeyRegistered: boolean;
  hotkeyError: string | null;
  hotkeyWarnings: string[]; // problems with the optional shortcuts
  lastError: string | null;
  warnings: string[];
  savingCount: number;
  freeDiskBytes: number | null;
  audioTracks: string[];
}

export interface MonitorInfo { index: number; width: number; height: number; label: string }
export interface AudioDevice { id: string; name: string; kind: 'render' | 'capture'; isDefault: boolean }

export interface EncoderInfo { id: Exclude<EncoderId, 'auto'>; label: string; hardware: boolean; available: boolean; error?: string }

export interface ClipRecord {
  id: string;
  title: string;
  filePath: string;
  createdAt: string; // ISO
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  audioTracks: string[]; // titles, e.g. ["Desktop","Microphone"]
  favorite: boolean;
  tags: string[];
  thumbnail: string | null; // absolute path
  status: 'ok' | 'missing' | 'corrupt' | 'pending';
  kind: 'capture' | 'export' | 'import';
  sourceClipId?: string;
  pressMarkerSec?: number; // roughly where in the clip the save hotkey was pressed
}

export interface ExportOptions {
  resolution: 'original' | '1080p' | '720p';
  fps: 'source' | 30 | 60;
  quality: Quality;
  fileName: string; // without extension
}

export interface ExportJob {
  id: string;
  clipId: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number; // 0..1, from ffmpeg out_time
  outputPath: string | null;
  error: string | null;
}

export interface RecoveryInfo { sessionDir: string; seconds: number; segments: number }

export interface AppEvent {
  type: 'clip-saved' | 'clip-save-failed' | 'screenshot-saved' | 'screenshot-failed' | 'capture-interrupted' | 'library-changed' | 'library-save-failed' | 'export' | 'capture-status' | 'toast';
  payload: unknown;
}
