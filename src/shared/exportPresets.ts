// One-click export setups. These set shape and quality only; they make no promise about any site's limits.
import type { AspectMode, EditProject } from './project';
import type { ExportOptions } from './types';

export interface ExportPreset {
  id: string;
  label: string;
  hint: string;
  aspect: AspectMode | null; // null keeps the current framing
  resolution: ExportOptions['resolution'];
  fps: ExportOptions['fps'];
  quality: ExportOptions['quality'];
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'landscape', label: 'Landscape', hint: '16:9 at 1080p, 60 fps', aspect: '16:9', resolution: '1080p', fps: 60, quality: 'high' },
  { id: 'vertical', label: 'Vertical', hint: '9:16 at 1080×1920, for Shorts, Reels and TikTok', aspect: '9:16', resolution: '1080p', fps: 'source', quality: 'high' },
  { id: 'square', label: 'Square', hint: '1:1 at 1080×1080', aspect: '1:1', resolution: '1080p', fps: 'source', quality: 'high' },
  { id: 'small', label: 'Smaller file', hint: '720p at 30 fps, keeping your framing', aspect: null, resolution: '720p', fps: 30, quality: 'medium' },
];

export function presetMatches(preset: ExportPreset, p: Pick<EditProject, 'aspect'>, o: ExportOptions): boolean {
  return (preset.aspect === null || preset.aspect === p.aspect) && preset.resolution === o.resolution && preset.fps === o.fps && preset.quality === o.quality;
}
