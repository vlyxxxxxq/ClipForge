// Capture proof: desktop video (ddagrab) + WASAPI loopback + mic -> 2 s TS segments -> MP4.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? path.join(process.env.TEMP, 'cfproof');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const helper = path.resolve('native/bin/AudioCap.exe');
const id = process.pid;
const helpers = ['loopback', 'mic'].map((src) => {
  const pipe = `cf_${src}_${id}`;
  const p = spawn(helper, ['capture', '--pipe', pipe, '--source', src], { stdio: ['pipe', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => process.stderr.write(`[${src}] ${d}`));
  return { pipe, p, ready: new Promise((r) => p.stdout.once('data', r)) };
});
await Promise.all(helpers.map((h) => h.ready));
const args = ['-hide_banner', '-y'];
for (const h of helpers) args.push('-thread_queue_size', '1024', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', `\\\\.\\pipe\\${h.pipe}`);
args.push('-filter_complex', 'ddagrab=output_idx=0:framerate=60,hwdownload,format=bgra,scale=1920:1080,format=nv12[v]',
  '-map', '[v]', '-map', '0:a', '-map', '1:a', '-c:v', 'h264_amf', '-usage', 'lowlatency', '-rc', 'vbr_peak', '-b:v', '20M', '-maxrate', '30M',
  '-g', '120', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'aac', '-b:a', '160k', '-t', '9',
  '-f', 'segment', '-segment_time', '2', '-segment_format', 'mpegts', '-reset_timestamps', '0',
  '-segment_list', path.join(out, 'list.csv'), '-segment_list_type', 'csv', path.join(out, 'seg_%06d.ts'));
const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
ff.stderr.on('data', (d) => (log += d));
const code = await new Promise((r) => ff.on('close', r));
helpers.forEach((h) => h.p.stdin.end());
console.log('ffmpeg exit', code, log.slice(-300));
console.log(fs.readFileSync(path.join(out, 'list.csv'), 'utf8'));
