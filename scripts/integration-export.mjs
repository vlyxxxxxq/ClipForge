// Headless export check with a synthetic 2-track source: duration, size, audio gain, mute, cancellation.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { ExportService } = require('../dist/main/main/export/exportService.js');
const { initMedia } = require('../dist/main/main/media.js');
const P = require('../dist/main/shared/project.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-exp-'));
await initMedia(path.join(root, 'none'));
const src = path.join(root, 'src.mp4');
// 20 s 1080p60, track0 = 440 Hz desktop, track1 = 880 Hz mic, both at the same level.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
  '-f', 'lavfi', '-i', 'sine=f=880:sample_rate=48000', '-t', '20', '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-c:a', 'aac', '-metadata:s:a:0', 'title=Desktop', '-metadata:s:a:1', 'title=Microphone', src]);
const svc = new ExportService(path.join(root, 'tmp'));
const out = path.join(root, 'out');
const run = (project, opts) => new Promise(async (resolve) => {
  const job = await svc.start('c', project, opts, out, 60);
  svc.on('job', (j) => { if (j.id === job.id && j.state !== 'running') resolve(j); });
});
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries', 'format=duration:stream=codec_type,width,height,channels', f]));
const level = (f) => Number(/mean_volume: (-?[\d.]+)/.exec(execFileSync('ffmpeg', ['-hide_banner', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString() + '')?.[1]
  ?? /mean_volume: (-?[\d.]+)/.exec(require('node:child_process').spawnSync('ffmpeg', ['-hide_banner', '-i', f, '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString())[1]);

let p = P.createProject('c', { path: src, duration: 20, width: 1920, height: 1080, audioTracks: ['Desktop', 'Microphone'] });
p = P.setTrimEnd(P.setTrimStart(p, 2), 18); // 16 s
p = P.splitAt(p, 5); p = P.splitAt(p, 8); p = P.removeSegment(p, p.segments[1].id); // remove 3 s -> 13 s
p = { ...p, aspect: '9:16', framing: { zoom: 1.2, offsetX: 0.3, offsetY: 0 }, texts: [{ id: 't', text: 'Test "quote" 100%: ok', x: 0.5, y: 0.8, size: 0.06, color: '#ffcc00', start: 1, end: 6 }] };
const opts = { resolution: '720p', fps: 30, quality: 'medium', fileName: 'vertical' };

const results = {};
const base = await run({ ...p, audio: { desktopVolume: 1, desktopMuted: false, micVolume: 1, micMuted: true } }, { ...opts, fileName: 'desk-only' });
const quiet = await run({ ...p, audio: { desktopVolume: 0.25, desktopMuted: false, micVolume: 1, micMuted: true } }, { ...opts, fileName: 'desk-quarter' });
const mixed = await run({ ...p, audio: { desktopVolume: 0.5, desktopMuted: false, micVolume: 1.5, micMuted: false } }, opts);
const silent = await run({ ...p, audio: { desktopVolume: 1, desktopMuted: true, micVolume: 1, micMuted: true } }, { ...opts, fileName: 'vertical' }); // name collision -> "(2)"
for (const [k, j] of Object.entries({ base, quiet, mixed, silent })) results[k] = { state: j.state, file: j.outputPath && path.basename(j.outputPath), probe: j.outputPath && probe(j.outputPath), error: j.error };
results.gainDb = level(quiet.outputPath) - level(base.outputPath); // expect ~ -12 dB
// Cancellation: start a slow export and cancel it right away.
const before = new Set(fs.readdirSync(out));
const job = await svc.start('c', p, { ...opts, resolution: 'original', quality: 'ultra', fileName: 'cancel-me' }, out, 60);
setTimeout(() => svc.cancel(job.id), 700);
const cancelled = await new Promise((r) => svc.on('job', (j) => { if (j.id === job.id && j.state !== 'running') r(j); }));
await new Promise((r) => setTimeout(r, 500));
results.cancel = { state: cancelled.state, newFiles: fs.readdirSync(out).filter((f) => !before.has(f)), tempLeft: fs.readdirSync(path.join(root, 'tmp')), sourceIntact: fs.existsSync(src) };
console.log(JSON.stringify(results, null, 1));
