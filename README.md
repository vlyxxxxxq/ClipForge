# ClipForge

A local, account-free replay-buffer clipper and editor for Windows. Capture runs in the background, a global hotkey saves the last 15–120 seconds, and clips can be trimmed, split, reframed (16:9 / 9:16 / 1:1), mixed and captioned, then exported to MP4.

## Quick start (development)

Requirements: Windows 10/11 (64-bit), Node.js 20+ (tested with 26.13), .NET 10 SDK (only to rebuild the audio helper), FFmpeg 7+ on `PATH` (tested with gyan.dev 9.0.2 "full" build).

```bash
scoop install nodejs-lts ffmpeg
```

```bash
npm install
```

```bash
npm run build:native
```

```bash
npm run dev
```

`npm run dev` compiles the main process and renderer, then starts Electron. `npm test` runs the unit tests.

If `npm install` leaves `node_modules/electron/dist` without `electron.exe` (seen with Node 26, where Electron's extractor fails silently), unzip `%LOCALAPPDATA%\electron\Cache\*\electron-v33*-win32-x64.zip` into `node_modules/electron/dist` and write `electron.exe` into `node_modules/electron/path.txt`.

## Packaged build

```bash
npm run dist
```

This produces `release/win-unpacked/ClipForge.exe`, a portable folder (no installer) that includes the audio helper and a copy of `ffmpeg.exe`/`ffprobe.exe` taken from your Scoop install (or from `CLIPFORGE_FFMPEG_DIR`). The exe is unsigned. The .NET 10 Runtime must be installed for the audio helper.

**Public downloads must not include FFmpeg.** The `npm run dist` output is for your own use. Before publishing, remove `resources/resources/ffmpeg` from the copy you zip; the app then finds FFmpeg on `PATH` or through `CLIPFORGE_FFMPEG_DIR`, and shows a clear message if it can't.

## Using it

1. Open ClipForge and press **Start capture** (or enable *Start capture when ClipForge opens* on the Capture page).
2. Play. The top bar shows the recording state, how full the buffer is and the replay length.
3. Press **F8** (configurable) to save the last N seconds. A Windows notification confirms the save, and the clip appears in **Library**.
4. Select a clip to preview it, rename it, tag it, favorite it, reveal it in Explorer or delete it (removing from the library only, or moving the file to the Recycle Bin).
5. **Open in editor**: trim, split and remove sections, choose the aspect ratio, zoom and drag to reposition, balance desktop and mic audio, add text, then **Export MP4**. Exports go to `<clips folder>\Exports` and appear in the library.

Closing the window hides it to the tray; capture keeps running. Quit from the tray menu or from Settings → About.

Editor shortcuts: Space play/pause · S split · Delete remove selected section/text · I / O trim start/end to playhead · ←/→ one frame (Shift: 1 s) · Home/End · Ctrl+Z / Ctrl+Y. Ctrl+1–4 switch pages.

## Architecture

```
Electron main process (TypeScript)
├─ CaptureService ── spawns ─▶ AudioCap.exe ×N (.NET/NAudio, WASAPI) ──named pipe PCM──┐
│                  └ spawns ─▶ ffmpeg: ddagrab (DXGI Desktop Duplication) ─┬─ h264_amf/nvenc/qsv/x264
│                                                                        └─ 2 s MPEG-TS segments + segments.csv
│   ReplayBuffer (pure): tracks segments, selects the last N s, pins segments during saves, expires old ones
│   Save: wait for the in-progress segment to close → ffconcat → `-c copy` remux → MP4 (+faststart) → ffprobe → rename
├─ LibraryStore: library.json (atomic write), async ffprobe and thumbnail queue
├─ ExportService: one re-encoding ffmpeg filter graph per job (trim/concat, crop/scale, drawtext, volume/amix)
├─ cfmedia:// protocol: Range-capable streaming of library files and caches only
└─ IPC (validated) ◀──contextBridge──▶ React renderer (contextIsolation on, nodeIntegration off, sandbox)
```

Key decisions and tradeoffs:

- **FFmpeg `ddagrab` for video.** It's already in FFmpeg and runs Desktop Duplication on the GPU, so no custom capture code is needed. The cost is a GPU→CPU frame download before encoding: on this machine the zero-copy D3D11→AMF path failed (two GPUs), so frames go through `hwdownload`. At 1440p→1080p60 that measured ~59.4 fps with 0 dropped frames.
- **A native helper for audio.** FFmpeg's `dshow` input can't do WASAPI loopback (desktop audio). `AudioCap.exe` captures loopback and microphone with WASAPI, converts to 48 kHz stereo float, inserts silence when the device is idle (loopback sends nothing during silence) so audio stays on the wall clock, and streams over a named pipe. Desktop and mic are separate AAC tracks in every clip.
- **A segmented disk buffer.** 2 s TS segments with forced IDR keyframes on every boundary (AMF needs `-forced_idr 1 -header_spacing`, verified). Disk use is bounded to roughly the replay length plus 6 s (about 4–6 MB per segment at High/1080p60). Saving is a lossless remux, so it's fast and never re-encodes. A clip can be up to one segment (2 s) longer than requested, because cuts land on segment boundaries.
- **Saves wait for the active segment to close** (≤2 s), so every file in the clip is complete and the press moment is included. Segments used by a save are reference-counted and can't be deleted mid-save. Presses less than 1 s apart are ignored, and saves run one at a time.
- **Exports always re-encode** (libx264 High, yuv420p, AAC 192 kbps at 48 kHz, faststart), so trims and splits are frame-accurate. They write to an app-owned temp folder and are renamed into place only after ffprobe validates them. Cancelling deletes only that job's temp folder.
- **JSON with atomic replace** instead of SQLite. No native modules to rebuild, and the data is small.

## Capture limitations (please read)

- **Sources:** whole displays only (Desktop Duplication). Per-window capture isn't implemented (FFmpeg 9 has `gfxcapture`, which could add it later).
- **Fullscreen games:** borderless and windowed modes work. Some *exclusive* fullscreen or DRM-protected content can produce black frames under Desktop Duplication. This hasn't been tested with an exclusive-fullscreen game yet.
- **Multiple monitors:** each DXGI output can be picked (probed by index). Only outputs on the adapter FFmpeg selects are listed. If the selected display disappears, capture falls back to the first display and shows a warning.
- **Hardware encoding:** encoders are detected by actually encoding test frames. On this PC: AMD AMF works, NVENC/QSV are unavailable, and x264 is the fallback. If a hardware encoder fails at start-up, capture retries with x264 and reports why.
- **Audio:** desktop audio comes from one output device (the default, or the one you pick), not per-application. A missing or unplugged device is skipped with a warning. If a device disappears mid-session, capture restarts without it.
- **Performance:** capture costs GPU and some CPU time (frame download, scaling, AAC). It isn't zero-impact. The Capture page shows measured FPS, dropped frames and encoder speed.
- **Cursor:** the mouse cursor is captured.

## Data locations

- Clips: `%USERPROFILE%\Videos\ClipForge` (configurable). Exports go in `Exports\` inside it.
- App data (`%APPDATA%\ClipForge`): `settings.json`, `library.json`, `projects\` (editor projects), `thumbs\`, `editor-cache\`, `buffer\` (temporary segments), `export-tmp\`, `logs\clipforge.log` (rotated at 5 MB; the user's home folder is shown as `~`).

ClipForge only ever deletes temporary data inside its own app-data folders: expired buffer segments, editor caches and export temp files. It never deletes your clips automatically. Deleting from the library asks first, and moving a file to the Recycle Bin can be undone.

## Verification status

Verified on this machine (Windows 11, Radeon RX 9070 XT, FFmpeg 9.0.2):

| Area | How |
|---|---|
| Video + desktop + mic capture to playable MP4 | capture proof script, ffprobe: H.264 1080p60 + 2 AAC tracks, desktop level −24.8 dB |
| Save before buffer full, repeated/overlapping saves, save while paused, 1 s press debounce | `scripts/integration-capture.mjs` |
| Global hotkey with no window open | F8 sent with SendKeys while the window was closed → 32 s clip saved |
| Close-to-tray keeps capturing | WM_CLOSE sent to the window → window hidden, capture still recording |
| Restart persistence (settings, titles, tags, favorites) | hard-killed and relaunched |
| Crash recovery of orphaned buffer, no orphaned processes | `taskkill /F` during capture → recovery banner → recovered clip |
| Auto-restart after capture process dies | ffmpeg killed mid-session → new session, warning shown |
| Missing mic, missing display, unavailable encoder | `scripts/integration-devices.mjs` → capture runs with explicit warnings/fallback |
| Editor UI: 9:16, split, remove section, text, volume, export | driven through the real UI over DevTools; exported 1080×1920, 22.02 s, text rendered |
| Export accuracy | `scripts/integration-export.mjs`: exact 13.000 s durations, 720×1280, 25% volume measured −12.0 dB, mute removes the track, overwrite protection, cancel leaves no files |
| Packaged build | `release/win-unpacked/ClipForge.exe` with FFmpeg removed from PATH → bundled FFmpeg used, capture + save OK, clean quit |
| Unit tests (32) | replay-buffer selection/pinning/cleanup, capture/save args, edit-project math, export filter graphs, library/settings persistence, path safety |

Not yet verified, or known gaps:

- Exclusive-fullscreen games, HDR displays and protected content.
- Low disk space: the checks exist (warn below 2 GB, stop below 500 MB, refuse saves/exports without room) but haven't been exercised on a nearly full drive.
- The tray menu and saved-clip notification were built but not clicked or inspected visually in testing.
- Mic capture has been confirmed to produce a track, but voice quality and sync haven't been judged by ear.
- The editor preview is representative, not pixel-identical: text uses CSS layout while export uses FFmpeg drawtext with Segoe UI Bold. Position, size and timing match; line metrics can differ slightly.
- No installer and no code signing. Windows SmartScreen may warn on first run.

## Licenses and redistribution

- ClipForge source: yours (marked `UNLICENSED`/private in package.json).
- **FFmpeg:** not included in public downloads, which ask you to install it yourself. Local `npm run dist` builds copy your installed FFmpeg into the package; the gyan.dev "full" build is **GPL v3**, so that's fine for personal use, but sharing such a package means providing the license and the complete corresponding source for that exact build and its libraries. A link to the general FFmpeg site isn't enough.
- **Electron/Chromium:** MIT plus bundled third-party licenses (`LICENSE.electron.txt`, `LICENSES.chromium.html` in the package).
- **NAudio:** MIT. **.NET runtime:** MIT (installed separately).
- React, Vite, TypeScript, Vitest, electron-builder: MIT/Apache-2.0 (dev/build time; only React ends up in the bundle).
