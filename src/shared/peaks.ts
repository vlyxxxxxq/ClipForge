// Audio peak data for the editor's waveform, stored per source second so it follows trims and cuts.
import { EditProject, outputDuration, outputToSource } from './project';

export const PEAK_SAMPLE_RATE = 4000;
export const PEAKS_PER_SEC = 50;

/** Reduce 16-bit samples to one peak (0..1) per bin. */
export function computePeaks(samples: Int16Array, samplesPerBin = PEAK_SAMPLE_RATE / PEAKS_PER_SEC): number[] {
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += samplesPerBin) {
    let max = 0;
    const end = Math.min(samples.length, i + samplesPerBin);
    for (let k = i; k < end; k++) { const v = Math.abs(samples[k]); if (v > max) max = v; }
    out.push(Math.round((max / 32768) * 1000) / 1000);
  }
  return out;
}

/** The peak under each column of the output timeline, so removed sections disappear from the waveform. */
export function waveformColumns(p: Pick<EditProject, 'segments'>, peaks: number[], columns: number): number[] {
  const out = new Array<number>(columns).fill(0);
  const duration = outputDuration(p as EditProject);
  if (!duration || !peaks.length) return out;
  const perColumn = duration / columns;
  for (let c = 0; c < columns; c++) {
    const start = outputToSource(p as EditProject, c * perColumn).time;
    const a = Math.floor(start * PEAKS_PER_SEC);
    const b = Math.max(a + 1, Math.ceil((start + perColumn) * PEAKS_PER_SEC));
    let max = 0;
    for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
    out[c] = max;
  }
  return out;
}
