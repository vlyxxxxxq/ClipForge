# Handoff to Claude Code: ClipForge review follow-up

## Context

- Reviewer: ChatGPT Codex. Review date: 2026-11-01. Commit reviewed: ace2d22731bbb07236dfe9e6e3f8b481fa450a4c.
- Full findings: review/REVIEW.md (refer to IDs like F-01, G-03).
- The constraints in CODEX_REVIEW_PROMPT.md section 1 still apply.
- Review only: no existing repository files were changed, and no commits, pushes, app launches, capture, or integration runs were performed. Only these two review documents were added. Implement the follow-up only after the owner confirms the plan below.

## Verification state at review time

- All checks used disposable OS-temp source copies to preserve existing files. Node v24.22.1, npm 11.20.0. npm needed its installed Scoop directory added to PATH for nested scripts.
- `npm install --no-audit --no-fund`: failed, exit 1, Electron postinstall `getaddrinfo ENOTFOUND github.com`; also EPERM extraction/rename and deprecation warnings. A fresh installation is unverified. Subsequent checks used copied existing repository dependencies.
- `npm run typecheck`: passed, exit 0, no main/renderer diagnostics.
- `npm test`: exit 1, 29 passed / 3 failed / 32 total, 3 files passed / 1 failed; reproduced on a second temporary copy. Failures: persistence tests at `src/main/library/persistence.test.ts:20`, `:34`, `:68`, all EPERM on rename. An independent newly written file could not be renamed in OS-temp either. Rerun on the owner's unrestricted filesystem before diagnosing a product regression or weakening atomic writes.
- `npm run build`: initial nested-npm PATH failure; rerun with corrected PATH passed, exit 0. Vite transformed 34 modules; HTML 0.52 kB, CSS 11.85 kB, JS 186.65 kB. No new package/native build was verified.
- Source-only checks confirmed incomplete project acceptance, null-segment validator exception, and complete expiry of delayed-save history. No real media/device behavior was tested. Existing package measures 737,380,596 bytes (~703 MiB), with 455,444,480 bytes in FFmpeg/ffprobe.
- Do not substitute README's historical owner results for fresh verification. Owner-only matrix remains: AMF, exclusive fullscreen/HDR, low disk, device unplug/display change, sleep/resume, two-hour audio sync, parent hard kill, tray/notifications, and clean-machine packaging.

## Work items (do them in this order)

### 1. Reserve accepted replay saves immediately  [IDs: F-01]  [size: M]

- Why: A queued save currently loses history during expiry, stop or restart, even though its press was accepted. This is the core trust boundary of a replay app.
- Files: `src/main/capture/captureService.ts:332` (`requestSave`, `waitForSegment`, `writeClip`, `shutdown`); `src/main/capture/replayBuffer.ts:50` (`select`, `pin`, `collectExpired`).
- Change: Extract `saveCoordinator.ts`. At request acceptance create a job with session ID, press sequence/time, requested duration, track metadata and immediately reserved closed segments. Observe completion of that session's active segment independently of the remux queue; never substitute a new session. Make stop finalize/reserve accepted work before clearing unreserved buffer. Bound pending requests (default four, visibly reject overflow), release reservations in finally, and await accepted saves during orderly quit. Preserve recovery data on interruption. Remove timed-out segment waiters.
- Acceptance: Fake-clock/process tests hold save A for >retention, accept B after >1 s, expire segments and verify B retains its original history. Cover pause/stop/restart during the boundary wait, new-session seq collision, write failure and repeated hotkey presses. Queue depth returns to zero and all references release. Owner runs `scripts/integration-capture.mjs` and checks the press event appears in each accepted clip.
- Risks / do not: Do not disable expiry globally, allow an unbounded queue, concatenate discontinuous sessions, or delete user clips. Snapshot metadata instead of reading current status during remux.

### 2. Serialize capture transitions and own every process  [IDs: F-02, F-03, F-04]  [size: L]

- Why: Pending startup can outlive Stop, and capture spawn errors have no event handler. Parent-death cleanup currently has stronger guarantees for AudioCap than FFmpeg.
- Files: `src/main/capture/captureService.ts:75` (`start`, `launch`, `spawnHelper`, `restartAfterDeviceLoss`, `stopProcesses`); `src/main/main.ts:197` (`settings:set`), `:319` (`before-quit`); `src/main/util.ts:56` (`run`); `src/renderer/CapturePage.tsx:89`; `native/AudioCap/Program.cs:65`; `src/main/export/exportService.ts:86`.
- Change: Extract `captureSession.ts` and a process supervisor. Serialize lifecycle transitions with generation tokens checked after awaits; attach generation to helper/FFmpeg callbacks. Handle `error` and stdin failures, and require actual readiness before recording state. Await helper shutdown and apply one bounded restart/backoff policy to both audio and video failure. Coalesce settings changes at interaction end. Add suspend/resume handling with explicit intended capture state. Enforce kill-on-close Windows Job Object ownership or document/test an equivalent parent watchdog for capture, save, export and media subprocesses; await job termination on graceful quit.
- Acceptance: Inject process/clock/media factories; test start-stop during device enumeration/helper readiness, two overlapping settings writes, stale helper exit, ENOENT, failed stdin, repeated device loss, stop during restart and suspend/resume. Final state and live child count match the last command; exactly one capture session runs. Owner hard-kills the app during capture/save/export and verifies owned PIDs exit and startup recovery remains available.
- Risks / do not: Never kill processes by generic executable name. Preserve save reservations from item 1. Treat parent-death behavior as unverified until measured on Windows; add native/process dependencies only with owner review of their license and maintenance cost.

### 3. Make export publication, cancellation and resource admission reliable  [IDs: F-05, F-06, F-07]  [size: L]

- Why: A valid export can fail only at final rename onto a second drive, and cancellation can race asynchronous probing. Multiple renderers/requests can also launch unlimited x264 jobs.
- Files: `src/main/export/exportService.ts:29` (`start`, close callback, `cancel`, `cancelAll`); `src/main/export/exportArgs.ts:24` (`buildExportArgs`); `src/main/main.ts:264`; `src/shared/types.ts:90`; `src/renderer/Editor.tsx:267`.
- Change: Encode in a uniquely named app-owned staging directory on the destination volume; persist/validate an ownership manifest so recovery removes only known staging data. Alternatively implement copy-to-destination-staging plus final same-volume rename, with both budgets accounted for. Use explicit queued/encoding/validating/publishing/terminal states and a serialized commit/cancel decision; check cancellation after every await. Default to one active encoder and a bounded queue. Cleanup on setup failures. Validate expected duration (<=max(0.1 s, two output frames)), dimensions, and audio presence before publication; surface disk errors with no final file. Keep full job state available across editor navigation.
- Acceptance: Mock cross-volume/EXDEV, ENOSPC, setup failure, spawn failure and malformed probe output. Hold probe pending, cancel, release probe: exactly one cancelled result, no final file, no staging remains after cleanup. Queued cancellation spawns nothing. Owner runs `scripts/integration-export.mjs`, plus a real export to another volume and constrained-disk test; source and existing outputs remain intact.
- Risks / do not: Never recursively clean Exports or an arbitrary caller path. Do not report successful completion before verified publication, or cancelled before the operation can no longer publish. Update UI/types for any added states.

### 4. Validate IPC, recovery identity and media requests  [IDs: F-08, F-09, F-10]  [size: L]

- Why: Current project validation can accept invalid state or throw, while recovery can target the active buffer and protocol ranges are incorrect. Fix the privileged boundary before adding channels.
- Files: `src/shared/project.ts:149` (`validateProject`); `src/main/main.ts:137` (`loadProject`), `:162` (`allowedMedia`, `handleMedia`), `:194` (`registerIpc`); `src/preload/preload.ts:5`; `src/renderer/api.ts:7`; `src/main/capture/captureService.ts:394` (`findOrphans`, `recoverOrphan`, `discardOrphan`); `src/main/capture/replayBuffer.ts:22`.
- Change: Add `shared/ipc.ts` request/response contracts and total runtime parsers. Validate trusted main-frame sender identity, full projects, booleans/IDs, finite FPS, source-bounded segments, framing/audio/text limits, uniqueness and maximum payload sizes. Resolve authoritative media metadata in main. Extract `captureRecovery.ts`: opaque registered orphan IDs, direct-child generated session names, generated `.ts` basenames, canonical containment and rejection of directory links; exclude active/pinned/recovering sessions and keep metadata per job. Extract `mediaProtocol.ts` with host/method/URI guards, correct single byte-range/suffix/HEAD handling, safe errors and regular-file checks. Constrain CORS using a trusted app origin or a narrowly justified current-origin policy; preserve Web Audio playback.
- Acceptance: Tests reject null nested entries, missing fields, NaN/Infinity, oversized data, unknown sender frames, forged paths/metadata, active-session discard, traversal/absolute CSV entries and linked directories. Range tests cover `0-0`, `100-`, `-500`, reversed/overflow/multiple/malformed values, empty files, missing files, malformed percent escapes, HEAD and stream errors. Owner checks seeking and both audio tracks after protocol changes.
- Risks / do not: Preserve contextIsolation=true, nodeIntegration=false, sandbox=true, CSP and argument arrays/shell=false. CORS removal alone breaks anonymous Web Audio; no claimed remote exploit was demonstrated. Choose documented maximums (suggest 500 segments, 100 overlays, 4096 chars/overlay) and validate legitimate editor projects against them.

### 5. Preserve and recover metadata when persistence fails  [IDs: F-11]  [size: M]

- Why: An empty fallback hides metadata loss; valid-but-wrong JSON can prevent startup. Atomic replacement alone is insufficient recovery behavior.
- Files: `src/main/util.ts:6` (`writeJsonAtomic`, `readJson`); `src/main/library/libraryStore.ts:26` (constructor, `persist`, `flush`); `src/main/settings.ts:53` (constructor, `set`); `src/main/library/persistence.test.ts:60`; project persistence currently in `src/main/main.ts:135`.
- Change: Add versioned validators and `projectStore.ts`. Preserve corrupt/unsupported input with a clearly surfaced recovery state; load a validated last-known-good backup if available. Define explicit migrations and refuse destructive writes to unknown newer schemas. Catch scheduled flush errors and retain dirty data for retry. Write settings durably before changing in-memory effective state. Reconcile orphaned generated temp outputs and clips committed before library metadata was flushed through a user-reviewable import/recovery flow.
- Acceptance: Fault-injection tests for truncated JSON, `null`, non-array clips, invalid records, unknown/new versions, leftover temp files, failed write/fsync/rename and retry. Verify originals/backups remain recoverable, startup stays usable and failure is visible. Rerun persistence tests outside the review sandbox; all 32 existing tests must pass there before calling baseline green.
- Risks / do not: Do not solve EPERM by removing fsync/atomic replacement. Do not auto-delete media or silently overwrite an unreadable library. Do not add SQLite in this item.

### 6. Retain editor edits and bind caches to source revisions  [IDs: F-12, F-13, G-23]  [size: M]

- Why: Leaving within the autosave debounce loses edits; relink can replay audio/filmstrips from the old file. These are visible workflow failures independent of capture hardware.
- Files: `src/renderer/Editor.tsx:50` (load effect, autosave, audio graph); `src/renderer/App.tsx:75`; `src/main/main.ts:137` (`loadProject`); `src/main/library/libraryStore.ts:81` (`relink`, `pumpThumbs`); `src/main/export/exportArgs.ts:34`; `src/renderer/Library.tsx:115`.
- Change: Extract `useProjectAutosave.ts` with dirty state owned beyond page unmount or an awaited navigation flush; display retryable failures. Guard stale loads and reset transport/source/job state. Version caches by canonical path, size and mtime (or stronger revision ID); invalidate on relink and require explicit confirmation before resetting incompatible edits. Guard thumbnail commits against source revision changes. Return indexed audio descriptors, including extraction failures, without compacting track indices; explicitly warn for imported tracks beyond the supported mix. Extract `useEditorPlayback.ts`, `Preview.tsx`, `Timeline.tsx`. Add keyboard trim and dialog focus/Escape behavior while covering those paths.
- Acceptance: Renderer tests edit then navigate at 100 ms and reopen, fail then retry save, resolve loads out of order, and fail extraction of track 0 only. Relink tests confirm new media and no stale thumbnail commits. Keyboard-only trim/delete-dialog checks pass. Add crop edge tests (1920x1080 portrait/right pan currently reaches x+w=1921); clamp rounded coordinates to the actual source.
- Risks / do not: Never silently transfer an old edit to unrelated replacement footage. Do not create renderer filesystem access or change exported audio based solely on display labels. Keep this shippable with current two-track capture support.

### 7. Measure and stabilize the native audio clock  [IDs: F-14]  [size: L]

- Why: Independent clocks and per-callback resampling are not a defensible long-session synchronization contract. Actual audible drift remains unmeasured.
- Files: `native/AudioCap/Program.cs:71` (`Capture`), `:123` (`Convert`); `src/main/capture/captureArgs.ts:55` (`buildCaptureArgs`); `src/main/capture/captureService.ts:122`; `src/shared/types.ts:40`.
- Change: Separate resampling/mixing from pipe writing. Preserve fractional phase across blocks, implement a documented surround downmix, and report queue overflow, inserted/dropped frames and clock error. Establish a shared monotonic startup epoch and timestamp/align track data with video; version any native pipe protocol change with the consumer. Add deterministic conversion/clock tests without recording devices before adjusting drift correction. Add explicit telemetry for unsupported formats instead of silently returning empty samples.
- Acceptance: Test 44.1/48/96 kHz, mono/stereo/surround, irregular block sizes, silence/bursts, injected drift and slow pipe writes. Owner performs a two-hour simultaneous flash/click test at start and intervals, including unplug/restart and sleep. Proposed target: <=80 ms absolute offset, <=20 ms/hour change, zero unreported queue loss; report real measurements and revise target with owner if needed.
- Risks / do not: Do not claim existing captures are audibly wrong without measurement. Do not hide overload with unrestricted buffering or random sample drops; preserve separate mic/desktop tracks and graceful parent exit.

### 8. Bound auxiliary storage and expose safe cleanup  [IDs: F-15, G-09, G-22]  [size: M]

- Why: Cache and log growth outlive the bounded replay ring. Storage visibility is valuable before adding long recordings or local models.
- Files: `src/main/main.ts:146`; `src/main/capture/captureService.ts:254` (`cleanup`, `removeEmptySessionDirs`); `src/main/logger.ts:12` (`initLogger`, `write`); `src/renderer/GeneralPage.tsx:24`; `src/renderer/CapturePage.tsx:24`.
- Change: Add a cache budget/LRU service (suggest 2 GiB default, configurable), excluding active editor/export files. Rotate logs during writes with fixed retention. Remove only expired, unpinned, non-recoverable session metadata. Show clip/export/cache/buffer totals and capture-health metrics with accurate labels; provide a preview of any user-requested cleanup and explicit confirmation for media Recycle Bin actions.
- Acceptance: Fixture tests exceed budgets, hold active cache leases, retain crash orphans, and simulate locked files; cleanup stays inside canonical owned roots and retries safely. Long-write logging stays bounded. Storage calculations match fixture bytes. Automated tests prove cleanup never removes clips, imports or completed exports.
- Risks / do not: No automatic user-media deletion. Orphan retention is intentional until the user recovers/discards it. Do not label encoder FPS as measured impact on game FPS.

### 9. Refresh Electron and prepare reproducible offline packaging  [IDs: F-16, F-17]  [size: L]

- Why: Electron 33 is out of support, and installing audio currently depends on a separate runtime. Two bundled media binaries dominate size.
- Files: `package.json:10`, `:25`, `:33`; `package-lock.json:3754`; `scripts/prepare-resources.mjs:6`; `native/AudioCap/AudioCap.csproj:4`; `docs/index.html:73`, `:90`; `src/main/main.ts:82`.
- Change: Review intermediate Electron breaking changes and select a supported stable line; keep sandbox settings intact. Pin FFmpeg/ffprobe provenance, hashes, build configuration, exact corresponding sources/dependencies and notices. Start with a self-contained AudioCap publish and package its whole required payload; benchmark minimal GPL FFmpeg builds while preserving needed functionality. Treat Native AOT as a separate compatibility/size experiment because NAudio/Windows COM may require changes. Add offline per-user NSIS plus portable build, preserve clips on uninstall, document measured installed/download sizes. Prepare signing/update configuration only after owner decisions; do not publish anything.
- Acceptance: Standard checks plus clean Windows VM without .NET/PATH FFmpeg: native helper enumerates and captures after user initiation, media protocol/audio seeking/tray/hotkey work, install/uninstall preserve media, bundle license/provenance manifest matches binaries. Compare actual sizes to 737,380,596-byte baseline. Verify packaging allowlist includes every runtime dependency. A build still using libx264 remains GPL; changing that needs explicit encoder/export redesign and license review.
- Risks / do not: Do not assume AOT works or promise an arbitrary size reduction. Do not link FFmpeg libraries into the app without reconsidering obligations. Signing can incur cost; network updates must be opt-in and ordinary use fully offline. Never publish releases, upload binaries, buy certificates or alter GitHub settings without approval.

### 10. Add trustworthy save cues, duration hotkeys and onboarding  [IDs: G-01, G-03, G-04, G-05, G-21, G-23]  [size: M]

- Why: The player needs immediate feedback that the intended moment was saved. The existing single hotkey/toast model is a useful base.
- Files: `src/main/main.ts:97` (`registerHotkey`, `saveClip`); `src/shared/types.ts:3`, `:27`; `src/main/capture/captureService.ts:332`; `src/renderer/Library.tsx:82`; `src/renderer/CapturePage.tsx:43`; `src/shared/project.ts:19`.
- Change: Add opt-in success/failure sounds tied to actual outcomes, independent 15/30/60/120 s bindings with conflict reporting, and persisted press-relative markers. Retention must cover the longest enabled duration. Add a screenshot command that saves real source pixels and confirms completion. Add skippable offline onboarding for source/audio/hotkey/storage plus a user-triggered test clip. Defer an overlay to a separate opt-in borderless-window increment after ordinary sounds/toasts work.
- Acceptance: Mocked IPC/UI tests prove no success cue for ignored/failed requests, correct duration/session/marker for each binding, conflicts surfaced without destroying working bindings, and onboarding never starts recording without explicit action. Owner checks cues in borderless gameplay and valid screenshot output. Keyboard/focus and reduced-motion behavior remain usable.
- Risks / do not: No simulated saves or always-on overlay injection; do not promise exclusive-fullscreen overlay compatibility. Use original/licensed sound/visual assets. Avoid sounds being unintentionally captured without explaining the tradeoff.

### 11. Improve local library organization and quick export  [IDs: G-07, G-08, G-10, G-11, G-16, G-17, G-18, G-23]  [size: L]

- Why: Date organization, precise scrubbing and a short path to a portrait export improve the daily workflow without requiring accounts or a capture rewrite.
- Files: `src/renderer/Library.tsx:30`, `:90`, `:115`; `src/renderer/Editor.tsx:249`, `:361`; `src/shared/project.ts:115`; `src/main/media.ts:101`; `src/main/main.ts:254`; `src/preload/preload.ts:5`.
- Change: Ship date groups and saved filters, keyboard multiselect/bulk tagging with explicit destructive confirmations, cached waveform peaks plus timeline zoom/scroll, then named landscape/portrait export presets with safe-area guides. Add native file drag/clipboard integration accepting only validated completed job IDs. Keep each subfeature independently releasable; game grouping can follow item 12 metadata.
- Acceptance: Renderer tests cover filtered multiselect, batch cancellation and focus restoration, waveform/source-time mapping across cuts, zoomed seek/trim, preset output dimensions and job-ID authorization. Synthetic export verifies selected presets. Owner checks actual file drag into Discord and clipboard interoperability; never claim support merely because Explorer reveal works.
- Risks / do not: Do not send messages or upload clips to Discord. No automatic cleanup, cloud indexing, copied UI artwork, or unverifiable platform upload-limit promises. Do not block ordinary editing on waveform generation.

### 12. Prototype game/window capture and process audio behind capabilities  [IDs: G-02, G-22]  [size: L]

- Why: Capturing only the game improves privacy and organization; a new native video backend is justified only by demonstrated reliability, source selection or performance benefits.
- Files: `src/main/capture/captureArgs.ts:60`; `src/main/capture/captureService.ts:116`; `src/main/media.ts:63`; `native/AudioCap/Program.cs:54`; `src/shared/types.ts:9`, `:64`; `src/renderer/CapturePage.tsx:53`.
- Change: Add a capture-backend interface and local executable allowlist/foreground detector. Persist optional game/session metadata with migrations. Probe the actual bundled FFmpeg's `gfxcapture` options, then implement opt-in window selection with visible source identity and explicit target-loss behavior. Add optional process-tree audio using Microsoft's process-loopback API when OS build >=20348, otherwise retain endpoint loopback. Benchmark against current ddagrab. Prototype native WGC/DXGI -> GPU conversion -> AMF only if the owner accepts the measurement gate; keep readback fallback. Flag HDR unsupported until explicit float/tone-map/color tests pass.
- Acceptance: Unit tests cover capability fallback, unsupported Windows versions, PID reuse, game exit, window resize/minimize/loss and schema migration. Owner measures identical game scenes at 1080p60/1440p60: average/1%-low game FPS, CPU/GPU, drops, encode speed, save latency, output quality, and two-hour sync. Suggested adoption gate: >=20% relative capture-overhead reduction or a material source-selection benefit without reliability loss; recording must never silently switch to another private window. Exclusive-fullscreen/HDR outcomes are recorded honestly.
- Risks / do not: No anti-cheat-sensitive injection, DRM bypass, mandatory newer-OS-only path, or guaranteed zero-copy claim. Common GPU device/adapter compatibility must be demonstrated on the dual-GPU AMF machine. This is a prototype with an explicit keep/reject outcome, not authorization for an unconditional backend rewrite.

## Decisions needed from the owner

- Save semantics: wait for segment closure (fast lossless, includes post-press frames) or optional exact endpoint? Recommended default: retain fast remux and expose exact re-encode later; never silently change existing save behavior.
- Startup/sleep/target-loss policy and privacy: Recommended default: resume only if capturing before suspension; when a selected game/window disappears, pause and notify rather than silently capture another source. Confirm whether existing missing-display fallback should require explicit consent.
- Audio goals and performance budget: Recommended default: separate mic plus game-process audio where supported, endpoint fallback clearly labelled; proposed sync <=80 ms and drift <=20 ms/hour. Proposed game-impact budget <=3% average and <=5% 1%-low FPS regression, to be adjusted using actual games.
- Installation/distribution scope: Recommended default: keep personal offline use, self-contained helper, NSIS and portable artifacts; no automatic publishing/updater. If distributing, decide a GPL-compliant exact-source delivery method and certificate budget. Recommended FFmpeg choice remains GPL/libx264 initially; LGPL conversion is a separate product/licensing decision.
- Storage/default advanced features: Recommended default: 2 GiB cache budget, four pending saves, one export encoder, zero automatic media deletion; advanced caption model packs and online sharing disabled until requested. Confirm representative games and whether G-06 long recordings outrank speed/captions. Features G-06/G-12/G-13/G-14/G-15/G-19/G-20 are intentionally outside this first 12-item queue.
- Native video investment: Recommended default: measure FFmpeg gfxcapture/process audio first. Authorize a full native backend only if the prototype meets the stated gate; retain current capture otherwise.

## Out of scope / rejected ideas

- Reimplementing the Electron UI in Tauri/WinUI now: expensive, and it leaves the dominant media-binary payload and capture/save races unresolved.
- SQLite migration as the first fix: versioned JSON validation/backups and guarded async commits solve the immediate problems with less migration risk. Revisit for indexed large libraries/transactional bulk edits.
- Uncompressed RAM replay ring, default compressed RAM ring or indefinitely pinning segments for long recording: memory/crash-recovery/storage costs are unjustified now. Keep the disk ring; design long recording explicitly later.
- Universal frame-accurate `-c copy` saves: arbitrary start frames require re-encoding or appropriate keyframe boundaries. Do not advertise impossible precision.
- Blind zero-copy or Native AOT conversion: both depend on actual adapter/COM/library capabilities. AOT and a native video backend are measurement-gated experiments, not guaranteed fixes.
- Required cloud/accounts, paid APIs, forced telemetry, automatic upload or social feed: conflict with the personal offline workflow. Any later network sharing is explicit opt-in with destination confirmation.
- Automatic deletion of user media, game injection/anti-cheat hooks/DRM bypass, or copying Medal names/artwork: rejected by the owner's constraints.
- Speed, transitions, stickers, caption models, long recording, GIF/WebM and network sharing in this initial queue: defer until reliability and time/source identity are dependable. Local captions remain a possible later opt-in feature with separate model/storage/license evaluation.

## Instructions for Claude Code

1. Read README.md, review/REVIEW.md and this file. Re-check each finding against the current code before changing anything; the code may have moved on since the review.
2. Confirm the plan and the "Decisions needed" with the owner before you start, then work through the items in order, one focused commit per item.
3. After each item, run `npm run typecheck`, `npm test` and `npm run build`. Run the relevant `scripts/integration-*.mjs` script when capture or export behavior changes.
4. Keep README.md's verification table and its list of unverified items accurate.
5. Report honestly what was verified and what wasn't. Don't push, publish releases or change GitHub settings without the owner's approval.
