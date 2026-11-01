// Drives the real app over DevTools with a throwaway profile: a damaged settings file must show a notice,
// an edit made just before leaving the editor must be saved, and a replaced clip must not reuse old media.
// node scripts/integration-editor.mjs   (after npm run build)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9445;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ui-'));
const profile = path.join(root, 'profile');
fs.mkdirSync(profile);
const makeClip = (file, seconds, color) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=${color}:s=640x360:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=440:d=${seconds}`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
const clip = path.join(root, 'clip.mp4');
makeClip(clip, 6, 'red');
fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({ version: 1, clips: [{ id: 'clip1', filePath: clip, title: 'Test clip', createdAt: new Date().toISOString(), durationSec: 6, width: 640, height: 360, fps: 30, sizeBytes: fs.statSync(clip).size, audioTracks: ['Track 1'], favorite: false, tags: [], origin: 'import', status: 'pending', thumbnail: null }] }));
fs.writeFileSync(path.join(profile, 'settings.json'), 'not json at all');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electron = path.resolve('node_modules/electron/dist/electron.exe');
async function open() {
  const proc = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  if (!page) throw new Error('app did not open');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const evaluate = (expression) => new Promise((res, rej) => {
    const my = ++id;
    const on = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== my) return;
      ws.removeEventListener('message', on);
      if (m.result?.exceptionDetails) rej(new Error(m.result.exceptionDetails.exception?.description ?? 'page error')); else res(m.result?.result?.value);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  const waitFor = async (expr, what) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expr)) return; await sleep(200); }
    throw new Error('timed out waiting for ' + what);
  };
  const quit = async () => {
    const closed = new Promise((r) => proc.once('close', r));
    await evaluate(`window.clipforge.call('app:quit').catch(() => 0); 0`).catch(() => {});
    await Promise.race([closed, sleep(10000)]);
    if (proc.exitCode === null) proc.kill();
    ws.close();
    await sleep(500);
  };
  return { evaluate, waitFor, quit };
}

const openEditor = `(() => {
  const card = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent === 'Test clip');
  card?.click();
  const b = [...document.querySelectorAll('button')].find((x) => /open in editor/i.test(x.textContent));
  b?.click();
  return !!b;
})()`;
const editorReady = `!!document.querySelector('.editor') && [...document.querySelectorAll('button')].some((b) => b.textContent === '9:16')`;

const results = {};
let app = await open();
try {
  await app.waitFor(`document.querySelectorAll('.banner.warn').length > 0`, 'damaged settings notice');
  results.damagedSettingsNotice = await app.evaluate(`document.querySelector('.banner.warn').textContent`);
  await app.waitFor(`document.body.innerText.includes('Test clip')`, 'library');
  await app.waitFor(openEditor, 'open in editor button');
  await app.waitFor(editorReady, 'editor');
  // Edit, then leave the page in the same moment: well inside the old 500 ms autosave delay.
  await app.evaluate(`(async () => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === '9:16').click();
    await new Promise((r) => setTimeout(r, 0)); // separate input events, as real ones always are
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', ctrlKey: true, bubbles: true }));
    return !document.querySelector('.editor');
  })()`);
  await sleep(300);
  results.leftEditorImmediately = await app.evaluate(`!document.querySelector('.editor')`);
  const projectFile = path.join(profile, 'projects', 'clip1.json');
  results.editSavedOnLeave = fs.existsSync(projectFile) && JSON.parse(fs.readFileSync(projectFile, 'utf8')).aspect === '9:16';
  await app.quit();

  // Replace the clip with different footage at the same path.
  const cacheBefore = fs.readdirSync(path.join(profile, 'editor-cache', 'clip1'));
  makeClip(clip, 12, 'blue');
  app = await open();
  await app.waitFor(`document.body.innerText.includes('Test clip')`, 'library');
  await app.waitFor(openEditor, 'open in editor button');
  await app.waitFor(editorReady, 'editor');
  await sleep(500);
  const cacheAfter = fs.readdirSync(path.join(profile, 'editor-cache', 'clip1'));
  results.newCacheForReplacedClip = cacheAfter.length === 1 && cacheAfter[0] !== cacheBefore[0];
  results.toastAboutChange = await app.evaluate(`document.body.innerText.includes('video file has changed')`);
  results.oldEditsKept = fs.readdirSync(path.join(profile, 'projects')).some((f) => f.includes('.replaced-'));
  const loaded = await app.evaluate(`window.clipforge.call('editor:load', 'clip1').then((r) => ({ aspect: r.project.aspect, duration: Math.round(r.project.source.duration), track0: !!r.audio[0] }))`);
  results.freshProject = loaded;
  await app.quit();
} catch (e) {
  results.error = e.message;
  await app.quit().catch(() => {});
}
console.log(JSON.stringify(results, null, 1));
fs.rmSync(root, { recursive: true, force: true });
const ok = !results.error && results.damagedSettingsNotice && results.leftEditorImmediately && results.editSavedOnLeave && results.newCacheForReplacedClip && results.toastAboutChange && results.oldEditsKept && results.freshProject?.aspect !== '9:16' && results.freshProject?.duration === 12;
process.exit(ok ? 0 : 1);
