# Prompt: Review ClipForge and hand off to Claude Code

You are a senior desktop and media engineer. Your job is to **review** the ClipForge codebase in this repository: critique it, give opinions, and propose a prioritized plan to make it better and closer to what a polished gameplay clipping app like Medal offers. Another agent, **Claude Code**, built this project and will implement your recommendations. So your output must be precise and verifiable, and it must be written so that Claude Code can pick it up without asking questions.

**This is a review, not an implementation.** Do not change source code, configuration, dependencies, git history, or anything on GitHub. The only files you may create are `review/REVIEW.md` and `review/HANDOFF.md` (described below).

---

## 1. What ClipForge is

ClipForge is a local, account-free replay-buffer clipper and editor for Windows 10/11, built for the owner's personal use and inspired by Medal's core workflow:

1. The user launches the app and starts background capture.
2. They play a game.
3. They press a global hotkey (default F8) to save the last 15–120 seconds.
4. The clip appears in a local library.
5. They open it in the editor, trim, reframe (16:9, 9:16 or 1:1), mix audio and add text, then export to MP4.

The branding is original. **Do not suggest copying Medal's name, logo, UI artwork or any proprietary assets.** Matching features and workflow is fine; matching the look exactly is not.

### Stack and layout

Read `README.md` first. It contains the architecture diagram, the tradeoffs, the known limitations, and what has been verified on the owner's machine.

| Area | Files |
|---|---|
| Electron main process, IPC, tray, hotkey, `cfmedia://` protocol | `src/main/main.ts` |
| Capture lifecycle, saves, recovery, auto-restart | `src/main/capture/captureService.ts` |
| Pure replay-buffer logic (segment selection, pinning, expiry) | `src/main/capture/replayBuffer.ts` (+ `.test.ts`) |
| FFmpeg capture and save arguments (`ddagrab`, AMF/NVENC/QSV/x264, segment muxer) | `src/main/capture/captureArgs.ts` |
| ffprobe, monitor/encoder detection, thumbnails, filmstrips | `src/main/media.ts` |
| Library persistence (JSON, atomic writes, probe/thumbnail queue) | `src/main/library/libraryStore.ts` |
| Export filter graph and the job runner | `src/main/export/exportArgs.ts`, `exportService.ts` |
| Settings, logger, helpers | `src/main/settings.ts`, `logger.ts`, `util.ts` |
| Edit-project model (segments, trim, crop math, validation) | `src/shared/project.ts` (+ `.test.ts`), `src/shared/types.ts` |
| Preload (whitelisted IPC bridge) | `src/preload/preload.ts` |
| React renderer | `src/renderer/` (`App.tsx`, `Library.tsx`, `Editor.tsx`, `CapturePage.tsx`, `GeneralPage.tsx`, `styles.css`) |
| Native audio helper (.NET 10 + NAudio, WASAPI loopback/mic → named pipe) | `native/AudioCap/Program.cs` |
| Integration and dev scripts | `scripts/` |
| GitHub Pages landing page | `docs/index.html` |

### Hard constraints (any proposal must keep these)

- Electron renderers keep `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. The IPC surface stays narrow and validated.
- External processes are always spawned with argument arrays (`shell: false`), never shell strings.
- Paths are validated, and cleanup only touches app-owned folders. **User clips are never deleted automatically.**
- Nothing *requires* cloud services, accounts, subscriptions or paid APIs. Optional, opt-in online features (for example, sharing) are acceptable to propose, but they must be clearly marked as optional, and the app must stay fully usable offline.
- No faked behavior: no simulated recording, progress or saves.
- The bundled FFmpeg is a GPL build. Flag any proposal that changes licensing obligations.

### The owner's machine (for context; you won't have it)

- Windows 11, AMD Radeon RX 9070 XT (AMF works; NVENC and QSV are unavailable), FFmpeg 9.0.2 (gyan.dev full build), one 1920×1080 display at the moment.
- The zero-copy D3D11→AMF path failed on this dual-GPU setup, so frames go through `hwdownload` before encoding.

---

## 2. How to inspect

1. Read `README.md`, then the files in the table above, most important first: `captureService.ts`, `replayBuffer.ts`, `captureArgs.ts`, `main.ts`, `exportArgs.ts`, `project.ts`, `Editor.tsx`, `Program.cs`.
2. If your environment allows, run these and report the real results:
   - `npm install`
   - `npm run typecheck`
   - `npm test`
   - `npm run build`

   If something can't run (for example, there is no Windows, GPU, FFmpeg or .NET in your sandbox), say so plainly. Don't guess results.
3. **Do not** run the capture or integration scripts against a real desktop, and don't start the app. The owner will do any manual testing.
4. Verify every claim against the code. Cite `path:line` for each finding. If you aren't sure about something, label it as an assumption.

---

## 3. What to evaluate

Give honest opinions. Praise what's solid in a sentence or two, and spend most of your words on what should change.

**A. Correctness and robustness**
- Replay buffer: race conditions between saves, segment expiry, pause/stop and auto-restart; edge cases with repeated or overlapping hotkey presses; clock drift between the video and the audio pipes over long sessions.
- Failure handling: disk full, a device unplugged mid-session, a display or resolution change, encoder failure, the GPU driver resetting, sleep and resume.
- Process lifecycle: orphaned FFmpeg or AudioCap processes, behavior when the app is killed during a save or export, and startup recovery.
- Persistence: corrupt or partial JSON, migrations when the schema changes, concurrent writes.

**B. Performance and capture quality**
- The cost of `ddagrab → hwdownload → encode`. Is there a realistic zero-copy path, or should a native capture helper (Windows.Graphics.Capture / DXGI → hardware encoder) replace FFmpeg capture?
- Per-window or per-game capture (for example, FFmpeg 9's `gfxcapture`, or WGC in the native helper), exclusive fullscreen, and HDR to SDR.
- Per-application audio using the Windows process-loopback API (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`), compared with today's whole-device loopback.
- Audio/video sync accuracy, and whether saves could be cut tighter than segment boundaries (today a clip can run up to 2 s longer than requested).
- Disk use and write volume of the rolling buffer. Would a RAM ring buffer be better?

**C. Architecture and code quality**
- Size and cohesion of `main.ts`, `captureService.ts` and `Editor.tsx`. Recommend specific module splits, with names.
- IPC design and type safety between main, preload and renderer.
- Test coverage gaps (there are no renderer tests today) and which tests would add the most value.
- Packaging: there's no installer, no auto-update and no code signing, the build is 704 MB, and the app depends on the .NET 10 runtime. Propose concrete fixes (for example, a self-contained or AOT-compiled helper, an NSIS installer, or a smaller FFmpeg build), with their size and licensing tradeoffs.

**D. Security**
- The `cfmedia://` protocol handler: path validation, Range handling, and whether its wide-open CORS header is needed.
- IPC input validation, CSP, and anything that could let renderer content reach the filesystem or spawn processes.

**E. UX, and how far it is from Medal's experience**
Compare ClipForge with what Medal-style apps offer, and rate each item **Have / Partial / Missing**, with impact and effort:
- An in-game overlay or toast and a save sound when a clip is saved.
- Detecting running games automatically, starting capture per game, and organizing clips by game.
- Clip bookmarks and markers, a screenshot hotkey, a "save the last N seconds" hotkey per duration, and a long-recording mode alongside the replay buffer.
- Library: grouping by game or date, bulk actions, storage usage and a cleanup assistant (that never deletes automatically), and smart sort.
- Editor: audio waveforms, zoomable timeline, speed changes and slow motion, transitions, image or sticker overlays, auto-captions (local only, for example whisper.cpp), templates and presets for TikTok, Shorts and Reels.
- Export and sharing: quick export presets, copy to clipboard, drag and drop into Discord, optional local network or opt-in upload targets, and a GIF or WebM export.
- First-run onboarding, a performance-impact indicator, and visual polish (animations, a consistent design system, accessibility).

Keep every suggestion inside the constraints in section 1.

---

## 4. Output

Create a `review/` folder with two files.

### `review/REVIEW.md` (for the owner)

1. **Summary**: 5–10 sentences giving your overall opinion of the project.
2. **Verification**: the commands you ran and their real output (pass or fail counts), plus what you couldn't run and why.
3. **Findings**: a table with the columns `ID | Severity (critical/high/medium/low) | Area | path:line | Problem | Recommendation`. Use IDs like `F-01`.
4. **Gaps compared with Medal**: the Have / Partial / Missing table from section 3E, with impact and effort (S/M/L).
5. **Roadmap**: 3–5 milestones in priority order, each listing finding or feature IDs and what "done" looks like.
6. **Opinions**: the decisions you would make differently and why. For example: FFmpeg capture or a native helper, JSON or SQLite, Electron or something else. Be direct, but account for the cost of switching.

### `review/HANDOFF.md` (for Claude Code to resume the project)

Write this file to Claude Code directly. Claude Code will be given the repo and this file only. Use exactly this structure:

```markdown
# Handoff to Claude Code: ClipForge review follow-up

## Context
- Reviewer: ChatGPT Codex. Review date: <date>. Commit reviewed: <git rev-parse HEAD>.
- Full findings: review/REVIEW.md (refer to IDs like F-01, G-03).
- The constraints in CODEX_REVIEW_PROMPT.md section 1 still apply.

## Verification state at review time
<typecheck / test / build results, or "not run" and the reason>

## Work items (do them in this order)
### 1. <short title>  [IDs: F-xx, G-xx]  [size: S/M/L]
- Why: <one or two sentences>
- Files: <path:line, ...>
- Change: <concrete steps, specific enough to implement without guessing>
- Acceptance: <observable checks: tests to add or pass, commands, measurable behavior>
- Risks / do not: <what could break, constraints to respect>

### 2. ...

## Decisions needed from the owner
<questions that only the owner can answer before or during the work, each with a recommended default>

## Out of scope / rejected ideas
<suggestions you considered and dropped, with the reason, so they aren't proposed again>

## Instructions for Claude Code
1. Read README.md, review/REVIEW.md and this file. Re-check each finding against the current code before changing anything; the code may have moved on since the review.
2. Confirm the plan and the "Decisions needed" with the owner before you start, then work through the items in order, one focused commit per item.
3. After each item, run `npm run typecheck`, `npm test` and `npm run build`. Run the relevant `scripts/integration-*.mjs` script when capture or export behavior changes.
4. Keep README.md's verification table and its list of unverified items accurate.
5. Report honestly what was verified and what wasn't. Don't push, publish releases or change GitHub settings without the owner's approval.
```

Rules for the work items:
- At most 12 items, ordered by value relative to effort, with correctness and robustness fixes before new features.
- Each item must be independently shippable and must have acceptance checks that can be tested.
- Give file paths and function names. Write "Improve capture" never; write "Split `CaptureService.requestSave` into …" instead.

---

## 5. Tone

Be candid and specific. Don't pad, and don't make up problems to look thorough: if an area is fine, say so in one line and move on. Wherever a recommendation depends on hardware or on something you couldn't test, say what the owner should measure to decide.
