// Headless integration check of the real CaptureService (no Electron needed).
// node scripts/integration-capture.mjs  -> prints JSON results of ffprobe on saved clips.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { CaptureService } = require('../dist/main/main/capture/captureService.js');
const { initMedia } = require('../dist/main/main/media.js');
const { defaultSettings } = require('../dist/main/main/settings.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-int-'));
const clips = path.join(root, 'clips');
await initMedia(path.join(root, 'none'));
const svc = new CaptureService(path.join(root, 'buffer'), path.resolve('native/bin/AudioCap.exe'));
const s = { ...defaultSettings(root).capture, clipsDir: clips, replayDuration: 15, micEnabled: process.argv.includes('--mic'), ...JSON.parse(process.env.CF_SETTINGS ?? '{}') };
svc.configure(s);
let n = 0;
const name = () => path.join(clips, `clip${++n}.mp4`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries', 'format=duration:stream=codec_type,width,height', f]));
const results = {};

await svc.start();
console.log('status after start', JSON.stringify(svc.getStatus()));
if (svc.getStatus().state !== 'recording') process.exit(1);
await sleep(5000);
const early = svc.requestSave(name); // before buffer is full
const dup = svc.requestSave(name); // within 1 s: must be ignored
results.early = await early;
results.duplicateIgnored = (await dup) === null;
await sleep(14000);
const [a, b] = await Promise.all([svc.requestSave(name), sleep(1200).then(() => svc.requestSave(name))]); // overlapping saves
results.full = a; results.overlap = b;
results.bufferFiles = fs.readdirSync(fs.readdirSync(path.join(root, 'buffer')).map((d) => path.join(root, 'buffer', d))[0]).filter((f) => f.endsWith('.ts')).length;
results.status = svc.getStatus();
await svc.pause();
results.pausedSave = await svc.requestSave(name);
await svc.stop();
results.bufferAfterStop = fs.readdirSync(path.join(root, 'buffer')).length;
for (const k of ['early', 'full', 'overlap', 'pausedSave']) if (results[k]) results[k].probe = probe(results[k].file);
console.log(JSON.stringify(results, null, 1));
console.log('root', root);
