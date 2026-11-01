// Drives the real app over DevTools with a throwaway profile and test-pattern clips: first-run setup, library
// selection, waveform, zoom, keyboard trim, markers, presets with a real export, clipboard, and real global hotkeys.
// node scripts/integration-features.mjs [screenshotDir]   (after npm run build)
// It restores clipboard text afterwards, and it briefly records the screen into a temp folder that gets deleted.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9446;
const shots = process.argv[2];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-feat-'));
const profile = path.join(root, 'profile');
const clipsDir = path.join(root, 'clips');
fs.mkdirSync(profile); fs.mkdirSync(clipsDir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).trim();
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries', 'format=duration:stream=codec_type,width,height', f]));

const makeClip = (name, seconds) => {
  const f = path.join(root, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=440:d=${seconds}`, '-f', 'lavfi', '-i', `sine=880:d=${seconds},volume='if(lt(t,${seconds / 2}),0,1)':eval=frame`,
    '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata:s:a:0', 'title=Desktop', '-metadata:s:a:1', 'title=Microphone', f]);
  return f;
};
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const record = (id, title, file, createdAt) => ({ id, title, filePath: file, createdAt, durationSec: 12, width: 1920, height: 1080, fps: 30, sizeBytes: fs.statSync(file).size, audioTracks: ['Desktop', 'Microphone'], favorite: false, tags: [], kind: 'capture', status: 'pending', thumbnail: null, pressMarkerSec: 9 });
fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({ version: 1, clips: [
  record('a', 'Clip today', makeClip('a.mp4', 12), daysAgo(0)),
  record('b', 'Clip yesterday', makeClip('b.mp4', 12), daysAgo(1)),
  record('c', 'Clip older', makeClip('c.mp4', 12), daysAgo(45)),
] }));
const baseSettings = { capture: { clipsDir, replayDuration: 60 }, general: {} };
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(baseSettings));

const proc = spawn(path.resolve('node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { stdio: 'ignore' });
let page;
for (let i = 0; i < 60 && !page; i++) {
  await sleep(500);
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
if (!page) throw new Error('app did not open');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => {
  const my = ++id;
  const on = (e) => { const m = JSON.parse(e.data); if (m.id === my) { ws.removeEventListener('message', on); res(m.result ?? m.error); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id: my, method, params }));
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page error');
  return r.result?.value;
};
const waitFor = async (expr, what, tries = 150) => {
  for (let i = 0; i < tries; i++) { if (await ev(expr)) return; await sleep(200); }
  throw new Error('timed out waiting for ' + what);
};
const key = async (k, code = k, vk = 0, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const shot = async (name) => {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.data, 'base64'));
};
const clickButton = (text) => ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled); if (!b) throw new Error('no button: ' + ${JSON.stringify(text)}); b.click(); })()`);
const savedLibrary = () => JSON.parse(fs.readFileSync(path.join(profile, 'library.json'), 'utf8')).clips;

const r = {};
let clipboardBefore = null;
try {
  // --- first-run setup
  await waitFor(`!!document.querySelector('#setup-title')`, 'setup');
  await waitFor(`document.querySelectorAll('.setup-body select option').length > 0`, 'display list');
  r.setupFocusInside = await ev(`document.querySelector('.modal').contains(document.activeElement)`);
  r.setupDidNotStartCapture = (await ev(`window.clipforge.call('capture:status').then((s) => s.state)`)) === 'stopped';
  await shot('1-setup');
  await key('Escape', 'Escape', 27);
  await waitFor(`!document.querySelector('#setup-title')`, 'setup to close');
  await sleep(200);
  r.setupRemembered = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).general.setupDone === true;

  // --- library groups and multi-select
  await waitFor(`document.querySelectorAll('.card').length === 3 && document.querySelectorAll('.card img').length === 3`, 'clips and thumbnails');
  r.dateGroups = await ev(`[...document.querySelectorAll('.group-title')].map((e) => e.textContent)`);
  const clickCard = (title, init = '') => ev(`[...document.querySelectorAll('.card')].find((c) => c.textContent.includes(${JSON.stringify(title)})).dispatchEvent(new MouseEvent('click', { bubbles: true, ${init} }))`);
  await clickCard('Clip today');
  await clickCard('Clip older', 'shiftKey: true');
  await sleep(100);
  r.shiftSelected = await ev(`document.querySelectorAll('.card.selected').length`);
  await clickCard('Clip yesterday', 'ctrlKey: true');
  await sleep(100);
  r.ctrlDeselected = await ev(`document.querySelector('.bulk-bar strong').textContent`);
  await ev(`(() => { const i = document.querySelector('.bulk-bar input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'best'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(600);
  await shot('2-library');
  r.bulkTagged = savedLibrary().filter((c) => c.tags.includes('best')).map((c) => c.id).sort();
  await clickButton('Delete…');
  await waitFor(`!!document.querySelector('#del-title')`, 'delete dialog');
  r.deleteDialogCount = await ev(`document.querySelector('#del-title').textContent`);
  await key('Escape', 'Escape', 27);
  await sleep(100);
  r.escapeKeptClips = (await ev(`document.querySelectorAll('.card').length`)) === 3;

  // --- editor
  await clickCard('Clip today');
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Open in editor')`, 'details');
  await clickButton('Open in editor');
  await waitFor(`!!document.querySelector('canvas.waveform')`, 'waveform');
  await sleep(500);
  r.waveformDrawn = await ev(`(() => { const c = document.querySelector('canvas.waveform'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 100; })()`);
  r.pressMarkerShown = await ev(`document.querySelectorAll('.marker.press').length === 1`);
  await ev(`document.body.focus()`);
  await key('m', 'KeyM', 77);
  await sleep(100);
  r.userMarker = await ev(`document.querySelectorAll('.marker:not(.press)').length === 1`);
  const w0 = await ev(`document.querySelector('.timeline-inner').clientWidth`);
  await key('=', 'Equal', 187);
  await key('=', 'Equal', 187);
  await sleep(150);
  const w1 = await ev(`document.querySelector('.timeline-inner').clientWidth`);
  r.zoomWidened = w1 / w0 > 2;
  await shot('3-editor-zoomed');
  await clickButton('Fit');
  await ev(`document.querySelector('.handle.start').focus()`);
  await key('ArrowRight', 'ArrowRight', 39, 8); // Shift: one second
  await sleep(100);
  r.keyboardTrim = await ev(`Number(document.querySelector('.handle.start').getAttribute('aria-valuenow'))`);

  await clickButton('Vertical');
  await sleep(150);
  await clickButton('Safe area');
  await sleep(150);
  await shot('4-editor-vertical');
  r.presetLit = await ev(`[...document.querySelectorAll('.presets .btn')].find((b) => b.textContent === 'Vertical').classList.contains('toggled')`);
  await clickButton('Export MP4');
  await waitFor(`document.body.innerText.includes('Exported.') || document.body.innerText.includes('Export failed')`, 'export', 300);
  r.exportResult = await ev(`document.querySelector('.ok.small, .error-text.small')?.textContent`);
  const exported = fs.readdirSync(path.join(clipsDir, 'Exports')).filter((f) => !f.startsWith('.'));
  const info = probe(path.join(clipsDir, 'Exports', exported[0]));
  const v = info.streams.find((s) => s.codec_type === 'video');
  r.exportSize = `${v.width}x${v.height}`;
  r.exportDuration = Number(info.format.duration);
  await shot('5-exported');

  // --- clipboard (restores any text afterwards)
  try { clipboardBefore = ps('Get-Clipboard -Raw'); } catch { clipboardBefore = ''; }
  await clickButton('Copy file');
  await sleep(2500);
  r.clipboardHasFile = ps('(Get-Clipboard -Format FileDropList | Select-Object -First 1).Name') === exported[0];

  // --- real global hotkeys, sent as real keys. F13 and F14 do nothing in other apps.
  await ev(`window.clipforge.call('settings:get').then((s) => window.clipforge.call('settings:set', { ...s, capture: { ...s.capture, durationHotkeys: { 15: 'F13', 30: 'F13' }, screenshotHotkey: 'F14' } }))`);
  r.duplicateHotkeyWarning = await ev(`window.clipforge.call('capture:status').then((s) => s.hotkeyWarnings)`);
  await key('3', 'Digit3', 51, 2);
  await sleep(1500);
  await shot('6-capture');
  await ev(`window.clipforge.call('capture:start')`);
  await waitFor(`window.clipforge.call('capture:status').then((s) => s.state === 'recording')`, 'recording');
  await sleep(19000);
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{F14}'); Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait('{F13}')`);
  await waitFor(`window.clipforge.call('capture:status').then((s) => s.savingCount === 0)`, 'save');
  await sleep(3500);
  const saved = savedLibrary().filter((c) => !['a', 'b', 'c'].includes(c.id) && c.kind === 'capture');
  r.hotkeyClip = saved.map((c) => ({ durationSec: Math.round(c.durationSec * 10) / 10, pressMarkerSec: Math.round((c.pressMarkerSec ?? -1) * 10) / 10 }));
  const shotsDir = path.join(clipsDir, 'Screenshots');
  r.hotkeyScreenshot = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter((f) => f.endsWith('.png')).length : 0;
  r.autoplayAllowed = await ev(`(async () => { const c = new AudioContext(); await new Promise((r) => setTimeout(r, 100)); const s = c.state; c.close(); return s; })()`);
} catch (e) {
  r.error = e.message;
}
if (clipboardBefore !== null) { try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:CF_RESTORE'], { env: { ...process.env, CF_RESTORE: clipboardBefore || ' ' } }); } catch {} }
await ev(`window.clipforge.call('capture:stop').then(() => { window.clipforge.call('app:quit').catch(() => 0); return 0; })`).catch(() => {});
await Promise.race([new Promise((res) => proc.once('close', res)), sleep(10000)]);
if (proc.exitCode === null) proc.kill();
ws.close();
await sleep(500);
console.log(JSON.stringify(r, null, 1));
fs.rmSync(root, { recursive: true, force: true });
