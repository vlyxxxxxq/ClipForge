// Starts capture with a nonexistent microphone and display index; capture must still run, with warnings.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { CaptureService } = require('../dist/main/main/capture/captureService.js');
const { initMedia } = require('../dist/main/main/media.js');
const { defaultSettings } = require('../dist/main/main/settings.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-dev-'));
await initMedia(path.join(root, 'none'));
const svc = new CaptureService(path.join(root, 'buffer'), path.resolve('native/bin/AudioCap.exe'));
svc.configure({ ...defaultSettings(root).capture, clipsDir: path.join(root, 'clips'), replayDuration: 15, micEnabled: true, micDeviceId: '{0.0.1.00000000}.{deadbeef-0000-0000-0000-000000000000}', monitorIndex: 7, encoder: 'h264_nvenc' });
await svc.start();
await new Promise((r) => setTimeout(r, 4000));
const s = svc.getStatus();
const clip = await svc.requestSave(() => path.join(root, 'clips', 'c.mp4'));
console.log(JSON.stringify({ state: s.state, encoder: s.encoder, fallback: s.encoderFallbackReason, tracks: s.audioTracks, warnings: s.warnings, saved: clip?.durationSec }, null, 1));
await svc.stop();
