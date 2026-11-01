import type { AppEvent, AudioDevice, CaptureStatus, ClipRecord, EncoderInfo, ExportJob, ExportOptions, MonitorInfo, RecoveryInfo, Settings } from '../shared/types';
import type { EditProject } from '../shared/project';

declare global {
  interface Window {
    clipforge: {
      call(ch: string, ...args: unknown[]): Promise<any>;
      on(ch: 'event' | 'capture-status', fn: (p: any) => void): () => void;
    };
  }
}

export type ClipView = ClipRecord & { thumbnailUrl: string | null; videoUrl: string };
const c = (ch: string, ...a: unknown[]) => window.clipforge.call(ch, ...a);

export const api = {
  info: (): Promise<{ version: string; mediaError: string | null; logFile: string | null; dataNotices: string[] }> => c('app:info'),
  openLogs: () => c('app:openLogs'),
  quit: () => c('app:quit'),
  getSettings: (): Promise<Settings> => c('settings:get'),
  setSettings: (s: Settings): Promise<{ settings: Settings; hotkey: { ok: boolean; error: string | null } }> => c('settings:set', s),
  status: (): Promise<CaptureStatus> => c('capture:status'),
  start: () => c('capture:start'),
  stop: () => c('capture:stop'),
  pause: () => c('capture:pause'),
  resume: () => c('capture:resume'),
  save: () => c('capture:save'),
  screenshot: () => c('capture:screenshot'),
  devices: (refresh = false): Promise<{ monitors: MonitorInfo[]; audio: AudioDevice[]; encoders: EncoderInfo[] }> => c('capture:devices', refresh),
  clips: (): Promise<ClipView[]> => c('library:list'),
  refreshClips: (): Promise<ClipView[]> => c('library:refresh'),
  updateClip: (id: string, patch: Partial<ClipRecord>): Promise<ClipView> => c('library:update', id, patch),
  deleteClip: (id: string, deleteFile: boolean) => c('library:delete', id, deleteFile),
  reveal: (id: string) => c('library:reveal', id),
  copyClip: (id: string) => c('library:copy', id),
  dragClip: (id: string) => c('library:drag', id),
  relink: (id: string) => c('library:relink', id),
  importClips: () => c('library:import'),
  loadProject: (clipId: string): Promise<{ project: EditProject; pressMarker: number | null; fps: number; filmstrip: string | null; audio: (string | null)[]; videoUrl: string; notices: string[] }> => c('editor:load', clipId),
  waveforms: (clipId: string): Promise<(number[] | null)[]> => c('editor:waveform', clipId),
  saveProject: (p: EditProject) => c('editor:save', p),
  startExport: (p: EditProject, o: ExportOptions, fps: number): Promise<ExportJob> => c('export:start', p, o, fps),
  cancelExport: (id: string) => c('export:cancel', id),
  listExports: (): Promise<ExportJob[]> => c('export:list'),
  revealExport: (jobId: string) => c('export:reveal', jobId),
  copyExport: (jobId: string) => c('export:copy', jobId),
  recovery: (): Promise<RecoveryInfo[]> => c('recovery:list'),
  recover: (dir: string) => c('recovery:recover', dir),
  discardRecovery: (dir: string) => c('recovery:discard', dir),
  pickFolder: (): Promise<string | null> => c('dialog:folder'),
  onEvent: (fn: (e: AppEvent) => void) => window.clipforge.on('event', fn),
  onStatus: (fn: (s: CaptureStatus) => void) => window.clipforge.on('capture-status', fn),
};

export const fmtDuration = (s: number) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};
export const fmtTime = (s: number) => `${fmtDuration(s)}.${String(Math.floor((s % 1) * 10))}`;
export const fmtBytes = (b: number) => (b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);
