import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, protocol, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { initLogger, log, logFilePath } from './logger';
import { initMedia, probe, makeThumbnail, makeFilmstrip, extractAudioTrack } from './media';
import { CaptureService } from './capture/captureService';
import { LibraryStore } from './library/libraryStore';
import { ExportService } from './export/exportService';
import { defaultSettings, SettingsStore } from './settings';
import { isInside, readJson, writeJsonAtomic, uniquePath } from './util';
import { createProject, EditProject, validateProject } from '../shared/project';
import type { CaptureStatus, ExportOptions, Settings } from '../shared/types';

const L = log('main');
if (!app.requestSingleInstanceLock()) app.quit();

protocol.registerSchemesAsPrivileged([{ scheme: 'cfmedia', privileges: { stream: true, supportFetchAPI: true, bypassCSP: false, standard: true, secure: true } }]);

const userData = app.getPath('userData');
const paths = {
  buffer: path.join(userData, 'buffer'),
  thumbs: path.join(userData, 'thumbs'),
  cache: path.join(userData, 'editor-cache'),
  projects: path.join(userData, 'projects'),
  exportTmp: path.join(userData, 'export-tmp'),
  logs: path.join(userData, 'logs'),
};
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../..');
const audioHelper = app.isPackaged ? path.join(resources, 'native', 'AudioCap.exe') : path.join(resources, 'native', 'bin', 'AudioCap.exe');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let settings: SettingsStore;
let capture: CaptureService;
let library: LibraryStore;
let exporter: ExportService;
let mediaError: string | null = null;

function send(channel: string, payload: unknown) { win?.webContents.send(channel, payload); }

function trayIcon(state: CaptureStatus['state']): Electron.NativeImage {
  const s = 32, buf = Buffer.alloc(s * s * 4);
  const [r, g, b] = state === 'recording' ? [235, 64, 52] : state === 'paused' ? [240, 180, 40] : state === 'error' ? [200, 60, 200] : [140, 146, 160];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5), o = (y * s + x) * 4;
    const ring = d < 15 && d > 11, dot = d < 8;
    if (ring || dot) { buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = 255; }
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}

function updateTray(st: CaptureStatus) {
  if (!tray) return;
  tray.setImage(trayIcon(st.state));
  const label = { stopped: 'Capture off', starting: 'Starting…', recording: `Recording · last ${st.replayDuration}s`, paused: 'Paused', error: 'Capture error' }[st.state];
  tray.setToolTip(`ClipForge — ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { label: `Save clip (${st.hotkey})`, enabled: st.state === 'recording' || st.state === 'paused', click: () => saveClip() },
    { type: 'separator' },
    st.state === 'recording' ? { label: 'Pause capture', click: () => capture.pause() }
      : st.state === 'paused' ? { label: 'Resume capture', click: () => capture.resume() }
        : { label: 'Start capture', click: () => capture.start() },
    { label: 'Stop capture', enabled: st.state !== 'stopped', click: () => capture.stop() },
    { type: 'separator' },
    { label: 'Open ClipForge', click: () => showWindow() },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function showWindow() {
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 980, minHeight: 640, backgroundColor: '#0f1115', show: false, title: 'ClipForge',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '../../renderer/index.html'));
  win.once('ready-to-show', () => { if (!(settings.get().general.launchMinimized && process.argv.includes('--hidden'))) win?.show(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!quitting && settings.get().general.closeToTray) { e.preventDefault(); win?.hide(); }
  });
  win.on('closed', () => { win = null; });
}

// ---- hotkey -------------------------------------------------------------------------------

let registeredHotkey: string | null = null;
function registerHotkey(accel: string): { ok: boolean; error: string | null } {
  if (registeredHotkey) { globalShortcut.unregister(registeredHotkey); registeredHotkey = null; }
  let ok = false, error: string | null = null;
  try {
    ok = globalShortcut.register(accel, () => saveClip());
    if (!ok) error = `"${accel}" is already used by another application. Choose a different hotkey.`;
  } catch (e: any) { error = `"${accel}" is not a valid shortcut.`; }
  if (ok) registeredHotkey = accel;
  capture.setHotkeyStatus(accel, ok, error);
  L.info(`hotkey ${accel} registered=${ok}`);
  return { ok, error };
}

// ---- capture restarts ---------------------------------------------------------------------

// Sliders send many settings changes per second; restart once, after they settle.
let restartTimer: NodeJS.Timeout | null = null;
function scheduleCaptureRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (capture.isActive) { await capture.stop(); await capture.start(); }
  }, 600);
}

// ---- clips --------------------------------------------------------------------------------

function clipName(ext: string) {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  const base = `ClipForge ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return uniquePath(settings.get().capture.clipsDir, base, ext);
}

async function saveClip() {
  try {
    const saved = await capture.requestSave(clipName);
    if (!saved) return; // repeated press ignored
    const rec = await library.addFile(saved.file, 'capture', { durationSec: saved.durationSec, audioTracks: saved.audioTracks });
    send('event', { type: 'clip-saved', payload: rec });
    if (settings.get().general.notifyOnSave && Notification.isSupported())
      new Notification({ title: 'Clip saved', body: `${Math.round(saved.durationSec)}s · ${path.basename(saved.file)}`, silent: true }).show();
  } catch (e: any) {
    L.error('save failed: ' + e.message);
    send('event', { type: 'clip-save-failed', payload: e.message });
    if (Notification.isSupported()) new Notification({ title: 'Clip not saved', body: e.message, silent: true }).show();
  }
}

// ---- editor projects -----------------------------------------------------------------------

const projectFile = (clipId: string) => path.join(paths.projects, `${clipId.replace(/[^\w-]/g, '')}.json`);

async function loadProject(clipId: string) {
  const clip = library.get(clipId);
  if (!clip) throw new Error('Clip not found');
  if (!fs.existsSync(clip.filePath)) throw new Error('The clip file is missing. It may have been moved or deleted.');
  const info = await probe(clip.filePath);
  const saved = readJson<unknown>(projectFile(clipId), null);
  let project: EditProject = validateProject(saved) && saved.source.path === clip.filePath ? saved
    : createProject(clipId, { path: clip.filePath, duration: info.duration, width: info.width, height: info.height, audioTracks: info.audioTracks });
  project = { ...project, source: { path: clip.filePath, duration: info.duration, width: info.width, height: info.height, audioTracks: info.audioTracks } };
  const cacheDir = path.join(paths.cache, clipId);
  const strip = path.join(cacheDir, 'filmstrip.jpg');
  if (!fs.existsSync(strip)) await makeFilmstrip(clip.filePath, strip, info.duration).catch((e) => L.warn('filmstrip: ' + e.message));
  const audio: string[] = [];
  for (let k = 0; k < info.audioTracks.length; k++) {
    const f = path.join(cacheDir, `track${k}.m4a`);
    if (!fs.existsSync(f)) await extractAudioTrack(clip.filePath, k, f).catch((e) => L.warn('audio extract: ' + e.message));
    if (fs.existsSync(f)) audio.push(mediaUrl(f));
  }
  return { project, fps: info.fps, filmstrip: fs.existsSync(strip) ? mediaUrl(strip) : null, audio, videoUrl: mediaUrl(clip.filePath) };
}

// ---- media protocol: serves only library media and app caches, with Range support ---------------

function mediaUrl(file: string) { return `cfmedia://media/${encodeURIComponent(file)}`; }

function allowedMedia(file: string): boolean {
  if (isInside(paths.thumbs, file) || isInside(paths.cache, file)) return true;
  return library.list().some((c) => path.resolve(c.filePath) === path.resolve(file));
}

function handleMedia(req: Request): Response {
  const url = new URL(req.url);
  const file = decodeURIComponent(url.pathname.slice(1));
  if (!allowedMedia(file) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
  const size = fs.statSync(file).size;
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const type = file.endsWith('.jpg') ? 'image/jpeg' : file.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...cors, 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers: { ...cors, 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
}

// ---- IPC ------------------------------------------------------------------------------------

const str = (v: unknown, max = 4096) => { if (typeof v !== 'string' || v.length > max) throw new Error('Invalid argument'); return v; };

function clipView(c: ReturnType<LibraryStore['list']>[number]) {
  return { ...c, thumbnailUrl: c.thumbnail && fs.existsSync(c.thumbnail) ? mediaUrl(c.thumbnail) + `?v=${c.sizeBytes}` : null, videoUrl: mediaUrl(c.filePath) };
}

function registerIpc() {
  const h = (ch: string, fn: (...a: any[]) => any) => ipcMain.handle(ch, async (_e, ...a) => fn(...a));
  h('app:info', () => ({ version: app.getVersion(), mediaError, logFile: logFilePath(), userData }));
  h('settings:get', () => settings.get());
  h('settings:set', async (next: unknown) => {
    const prev = settings.get();
    const s = settings.set(next);
    capture.configure(s.capture);
    let hotkey = { ok: true, error: null as string | null };
    if (s.capture.hotkey !== prev.capture.hotkey) hotkey = registerHotkey(s.capture.hotkey);
    const restartNeeded = JSON.stringify({ ...prev.capture, hotkey: 0, replayDuration: 0, clipsDir: 0, autoStartCapture: 0 }) !==
      JSON.stringify({ ...s.capture, hotkey: 0, replayDuration: 0, clipsDir: 0, autoStartCapture: 0 });
    if (restartNeeded) scheduleCaptureRestart();
    return { settings: s, hotkey };
  });
  h('capture:status', () => capture.getStatus());
  h('capture:start', () => capture.start());
  h('capture:stop', () => capture.stop());
  h('capture:pause', () => capture.pause());
  h('capture:resume', () => capture.resume());
  h('capture:save', () => saveClip());
  h('capture:devices', async (refresh?: boolean) => ({
    monitors: await capture.getMonitors(!!refresh),
    audio: await capture.listAudioDevices().catch((e) => { L.warn(e.message); return []; }),
    encoders: await capture.getEncoders(!!refresh),
  }));
  h('hotkey:test', (accel: string) => registerHotkey(str(accel, 40)));
  h('library:list', () => library.list().map(clipView));
  h('library:refresh', async () => { await library.verifyAll(); return library.list().map(clipView); });
  h('library:update', (id: string, patch: any) => {
    const p: any = {};
    if (typeof patch?.title === 'string') p.title = patch.title.slice(0, 200);
    if (typeof patch?.favorite === 'boolean') p.favorite = patch.favorite;
    if (Array.isArray(patch?.tags)) p.tags = patch.tags.filter((t: unknown) => typeof t === 'string').map((t: string) => t.trim().slice(0, 32)).filter(Boolean).slice(0, 20);
    const r = library.patch(str(id), p);
    return r && clipView(r);
  });
  h('library:delete', async (id: string, deleteFile: boolean) => {
    const c = library.get(str(id));
    if (!c) return;
    if (deleteFile && fs.existsSync(c.filePath)) await shell.trashItem(c.filePath); // recycle bin, recoverable
    library.remove(c.id, false);
    fs.rmSync(path.join(paths.cache, c.id), { recursive: true, force: true });
  });
  h('library:reveal', (id: string) => { const c = library.get(str(id)); if (c && fs.existsSync(c.filePath)) shell.showItemInFolder(c.filePath); else if (c) shell.openPath(path.dirname(c.filePath)); });
  h('library:relink', async (id: string) => {
    const r = await dialog.showOpenDialog(win!, { title: 'Locate clip', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov'] }] });
    if (!r.canceled && r.filePaths[0]) await library.relink(str(id), r.filePaths[0]);
  });
  h('library:import', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Import clips', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov'] }] });
    for (const f of r.canceled ? [] : r.filePaths) await library.addFile(f, 'import');
  });
  h('editor:load', (clipId: string) => loadProject(str(clipId)));
  h('editor:save', (project: unknown) => {
    if (!validateProject(project)) throw new Error('Invalid project');
    const clip = library.get(project.clipId);
    if (!clip || clip.filePath !== project.source.path) throw new Error('Project does not match clip');
    writeJsonAtomic(projectFile(project.clipId), { ...project, updatedAt: new Date().toISOString() });
    return true;
  });
  h('export:start', async (project: unknown, options: ExportOptions, fps: number) => {
    if (!validateProject(project)) throw new Error('Invalid project');
    const clip = library.get(project.clipId);
    if (!clip || clip.filePath !== project.source.path) throw new Error('Project does not match clip');
    const opts: ExportOptions = {
      resolution: ['original', '1080p', '720p'].includes(options?.resolution) ? options.resolution : '1080p',
      fps: options?.fps === 30 || options?.fps === 60 ? options.fps : 'source',
      quality: ['low', 'medium', 'high', 'ultra'].includes(options?.quality) ? options.quality : 'high',
      fileName: str(options?.fileName ?? 'export', 200),
    };
    return exporter.start(clip.id, project, opts, path.join(settings.get().capture.clipsDir, 'Exports'), Number(fps) || 60);
  });
  h('export:cancel', (id: string) => exporter.cancel(str(id)));
  h('export:list', () => exporter.list());
  h('export:reveal', (file: string) => { if (fs.existsSync(str(file))) shell.showItemInFolder(file); });
  h('recovery:list', () => capture.findOrphans());
  h('recovery:recover', async (dir: string) => {
    const saved = await capture.recoverOrphan(str(dir), clipName);
    await library.addFile(saved.file, 'capture', { title: 'Recovered clip', audioTracks: saved.audioTracks });
    capture.discardOrphan(dir);
  });
  h('recovery:discard', (dir: string) => capture.discardOrphan(str(dir)));
  h('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('app:quit', () => { quitting = true; app.quit(); });
  h('app:openLogs', () => shell.showItemInFolder(logFilePath() ?? paths.logs));
}

// ---- startup ----------------------------------------------------------------------------------

app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  initLogger(paths.logs);
  L.info(`ClipForge ${app.getVersion()} starting`);
  protocol.handle('cfmedia', handleMedia);
  const media = await initMedia(path.join(resources, 'resources'));
  if (!media.ok) mediaError = media.error ?? 'FFmpeg unavailable';
  settings = new SettingsStore(path.join(userData, 'settings.json'), defaultSettings(app.getPath('videos')));
  capture = new CaptureService(paths.buffer, audioHelper);
  capture.configure(settings.get().capture);
  library = new LibraryStore(userData, paths.thumbs, { probe, thumbnail: makeThumbnail });
  exporter = new ExportService(paths.exportTmp);
  exporter.cleanupOrphans();
  library.on('changed', () => send('event', { type: 'library-changed', payload: null }));
  capture.on('status', (st: CaptureStatus) => { send('capture-status', st); updateTray(st); });
  capture.on('source-lost', (msg: string) => {
    if (Notification.isSupported()) new Notification({ title: 'Capture paused', body: msg, silent: true }).show();
  });
  let resumeAfterSleep = false;
  powerMonitor.on('suspend', () => { resumeAfterSleep = capture.isActive; if (resumeAfterSleep) capture.pause(); });
  powerMonitor.on('resume', () => { if (resumeAfterSleep) capture.resume(); resumeAfterSleep = false; });
  exporter.on('job', (job) => {
    send('event', { type: 'export', payload: job });
    if (job.state === 'done' && job.outputPath) library.addFile(job.outputPath, 'export', { sourceClipId: job.clipId }).catch(() => {});
  });
  registerIpc();
  tray = new Tray(trayIcon('stopped'));
  tray.on('click', () => showWindow());
  registerHotkey(settings.get().capture.hotkey);
  updateTray(capture.getStatus());
  createWindow();
  library.verifyAll();
  if (!mediaError && settings.get().capture.autoStartCapture) capture.start();
});

app.on('window-all-closed', () => { /* keep running in the tray */ });

let cleanedUp = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (cleanedUp) return;
  e.preventDefault();
  (async () => {
    try {
      globalShortcut.unregisterAll();
      if (restartTimer) clearTimeout(restartTimer);
      exporter?.cancelAll();
      await capture?.shutdown();
      library?.flush();
    } catch (err: any) { L.error('shutdown: ' + err.message); }
    cleanedUp = true;
    app.quit();
  })();
});
