import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime } from './api';
import { createDebouncedSaver } from './debouncedSaver';
import type { Toast } from './App';
import {
  AspectMode, canvasSize, clamp, cropRect, EditProject, newId, outputDuration, outputToSource, removeSegment, setTrimEnd, setTrimStart,
  sourceToOutput, splitAt, TextOverlay,
} from '../shared/project';
import type { ExportJob, ExportOptions } from '../shared/types';

interface Loaded { fps: number; filmstrip: string | null; audio: (string | null)[]; videoUrl: string }

/** Undo/redo history. Rapid changes (slider drags) within 600 ms coalesce into one step. */
function useHistory(initial: EditProject | null) {
  const [state, setState] = useState<{ past: EditProject[]; present: EditProject | null; future: EditProject[]; t: number }>({ past: [], present: initial, future: [], t: 0 });
  const set = useCallback((next: EditProject | ((p: EditProject) => EditProject), coalesce = false) => {
    setState((s) => {
      if (!s.present) return s;
      const n = typeof next === 'function' ? next(s.present) : next;
      if (n === s.present) return s;
      const now = Date.now();
      const merge = coalesce && now - s.t < 600;
      return { past: merge ? s.past : [...s.past.slice(-99), s.present], present: n, future: [], t: coalesce ? now : 0 };
    });
  }, []);
  const reset = useCallback((p: EditProject) => setState({ past: [], present: p, future: [], t: 0 }), []);
  const undo = useCallback(() => setState((s) => s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present!, ...s.future], t: 0 } : s), []);
  const redo = useCallback(() => setState((s) => s.future.length ? { past: [...s.past, s.present!], present: s.future[0], future: s.future.slice(1), t: 0 } : s), []);
  return { project: state.present, set, reset, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

export function Editor({ clipId, toast, onBack }: { clipId: string | null; toast: (k: Toast['kind'], t: string) => void; onBack: () => void }) {
  const h = useHistory(null);
  const p = h.project;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [t, setT] = useState(0); // output time
  const [playing, setPlaying] = useState(false);
  const [selSeg, setSelSeg] = useState<string | null>(null);
  const [selText, setSelText] = useState<string | null>(null);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [opts, setOpts] = useState<ExportOptions>({ resolution: '1080p', fps: 'source', quality: 'high', fileName: '' });
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([]);
  const gains = useRef<GainNode[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const tRef = useRef(0);
  const projRef = useRef(p);
  projRef.current = p;
  const saver = useMemo(() => createDebouncedSaver<EditProject>(api.saveProject, 500, (e) => toast('error', 'Could not save project: ' + e.message)), []);

  useEffect(() => {
    if (!clipId) return;
    setError(null); setLoaded(null); setJob(null);
    let current = true; // a slower load for a previous clip must not replace this one
    api.loadProject(clipId).then((r) => {
      if (!current) return;
      h.reset(r.project);
      r.notices.forEach((n) => toast('error', n));
      setLoaded({ fps: r.fps, filmstrip: r.filmstrip, audio: r.audio, videoUrl: r.videoUrl });
      setOpts((o) => ({ ...o, fileName: `${r.project.source.path.split(/[\\/]/).pop()!.replace(/\.\w+$/, '')} edit` }));
      setT(0); tRef.current = 0;
    }).catch((e) => { if (current) setError(e.message); });
    // An export keeps running while you're elsewhere, so pick its progress back up.
    api.listExports().then((jobs) => {
      const active = jobs.filter((j) => j.clipId === clipId && (j.state === 'queued' || j.state === 'running')).pop();
      if (current && active) setJob(active);
    }).catch(() => {});
    const off = api.onEvent((e) => {
      if (e.type !== 'export') return;
      const next = e.payload as ExportJob;
      if (next.clipId === clipId) setJob((j) => (!j || j.id === next.id || j.state === 'done' || j.state === 'failed' || j.state === 'cancelled' ? next : j));
    });
    return () => { current = false; off(); saver.flush(); };
  }, [clipId]);

  // Persist the project (debounced) whenever it changes.
  useEffect(() => { if (p) saver.schedule(p); }, [p]);
  useEffect(() => {
    window.addEventListener('beforeunload', saver.flush);
    return () => { window.removeEventListener('beforeunload', saver.flush); saver.flush(); };
  }, [saver]);

  // Web Audio graph for per-track preview gain (supports >100%).
  useEffect(() => {
    if (!loaded?.audio.length) return;
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    gains.current = audioRefs.current.map((el) => {
      const g = ctx.createGain();
      if (el) ctx.createMediaElementSource(el).connect(g).connect(ctx.destination);
      return g;
    });
    return () => { ctx.close(); ctxRef.current = null; gains.current = []; };
  }, [loaded]);

  useEffect(() => {
    if (!p) return;
    const vols = [p.audio.desktopMuted ? 0 : p.audio.desktopVolume, p.audio.micMuted ? 0 : p.audio.micVolume];
    gains.current.forEach((g, i) => { g.gain.value = vols[i] ?? 1; });
    const v = videoRef.current;
    if (v && !loaded?.audio.some(Boolean)) { v.muted = p.audio.desktopMuted; v.volume = clamp(p.audio.desktopVolume, 0, 1); }
  }, [p?.audio, loaded]);

  const seek = useCallback((outT: number) => {
    const pr = projRef.current;
    if (!pr) return;
    const d = outputDuration(pr);
    const ct = clamp(outT, 0, d);
    const src = outputToSource(pr, ct).time;
    tRef.current = ct; setT(ct);
    if (videoRef.current) videoRef.current.currentTime = src;
    audioRefs.current.forEach((a) => { if (a) a.currentTime = src; });
  }, []);

  // Playback loop: follows the edit by jumping over removed sections and stops at the end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current, pr = projRef.current;
      if (!v || !pr) return;
      const { index } = outputToSource(pr, tRef.current);
      const seg = pr.segments[index];
      if (v.currentTime >= seg.end - 0.01) {
        if (index + 1 < pr.segments.length) {
          const next = pr.segments[index + 1].start;
          v.currentTime = next;
          audioRefs.current.forEach((a) => { if (a) a.currentTime = next; });
        } else { pause(); seek(outputDuration(pr)); return; }
      } else if (v.currentTime < seg.start - 0.05) {
        v.currentTime = seg.start;
      }
      const o = sourceToOutput(pr, v.currentTime);
      if (o !== null) { tRef.current = o; setT(o); }
      audioRefs.current.forEach((a) => { if (a && Math.abs(a.currentTime - v.currentTime) > 0.12) a.currentTime = v.currentTime; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const play = () => {
    const pr = projRef.current, v = videoRef.current;
    if (!pr || !v) return;
    if (tRef.current >= outputDuration(pr) - 0.05) seek(0);
    ctxRef.current?.resume();
    v.play().catch(() => {});
    audioRefs.current.forEach((a) => a?.play().catch(() => {}));
    setPlaying(true);
  };
  const pause = () => {
    videoRef.current?.pause();
    audioRefs.current.forEach((a) => a?.pause());
    setPlaying(false);
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const pr = projRef.current;
      if (!pr) return;
      const frame = 1 / (loaded?.fps || 60);
      if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? h.redo() : h.undo(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); h.redo(); }
      else if (e.key.toLowerCase() === 's' && !e.ctrlKey) h.set(splitAt(pr, tRef.current));
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selText) { h.set({ ...pr, texts: pr.texts.filter((x) => x.id !== selText) }); setSelText(null); }
        else if (selSeg) { h.set(removeSegment(pr, selSeg)); setSelSeg(null); }
      }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(tRef.current - (e.shiftKey ? 1 : frame)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seek(tRef.current + (e.shiftKey ? 1 : frame)); }
      else if (e.key.toLowerCase() === 'i') { h.set(setTrimStart(pr, outputToSource(pr, tRef.current).time)); seek(0); }
      else if (e.key.toLowerCase() === 'o') h.set(setTrimEnd(pr, outputToSource(pr, tRef.current).time));
      else if (e.key === 'Home') seek(0);
      else if (e.key === 'End') seek(outputDuration(pr));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, selSeg, selText, loaded]);

  if (!clipId) return <div className="empty"><h2>No clip open</h2><p>Choose a clip in the library and select “Open in editor”.</p><button className="btn" onClick={onBack}>Go to library</button></div>;
  if (error) return <div className="empty"><h2>Can’t open this clip</h2><p>{error}</p><button className="btn" onClick={onBack}>Back to library</button></div>;
  if (!p || !loaded) return <div className="empty">Preparing editor…</div>;

  const duration = outputDuration(p);
  const hasMic = p.source.audioTracks.length > 1;
  const textAt = p.texts.find((x) => x.id === selText) ?? null;
  const setText = (id: string, patch: Partial<TextOverlay>, coalesce = true) => h.set((q) => ({ ...q, texts: q.texts.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), coalesce);
  const exportSize = canvasSize(p, opts.resolution);

  const startExport = async () => {
    try { setJob(await api.startExport(p, { ...opts, fileName: opts.fileName || 'export' }, loaded.fps)); }
    catch (e: any) { toast('error', e.message); }
  };

  return (
    <div className="editor">
      <div className="editor-main">
        <Preview p={p} t={t} videoUrl={loaded.videoUrl} videoRef={videoRef} selText={selText} onSelectText={setSelText}
          onPan={(dx, dy) => h.set((q) => ({ ...q, framing: { ...q.framing, offsetX: clamp(q.framing.offsetX + dx, -1, 1), offsetY: clamp(q.framing.offsetY + dy, -1, 1) } }), true)}
          onMoveText={(id, x, y) => setText(id, { x, y })} />
        {loaded.audio.map((src, i) => src && <audio key={src} ref={(el) => { audioRefs.current[i] = el; }} src={src} crossOrigin="anonymous" preload="auto" />)}
        <div className="transport">
          <button className="btn icon" onClick={() => (playing ? pause() : play())} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
          <span className="timecode">{fmtTime(t)} / {fmtTime(duration)}</span>
          <div className="spacer" />
          <button className="btn" onClick={() => h.set(splitAt(p, t))} title="Split at playhead (S)">Split</button>
          <button className="btn" disabled={!selSeg || p.segments.length < 2} onClick={() => { if (selSeg) { h.set(removeSegment(p, selSeg)); setSelSeg(null); } }} title="Remove selected section (Delete)">Remove section</button>
          <button className="btn" onClick={() => h.set(setTrimStart(p, outputToSource(p, t).time))} title="Trim start to playhead (I)">Trim start</button>
          <button className="btn" onClick={() => h.set(setTrimEnd(p, outputToSource(p, t).time))} title="Trim end to playhead (O)">Trim end</button>
          <button className="btn" onClick={() => { const id = newId('t'); h.set({ ...p, texts: [...p.texts, { id, text: 'Your text', x: 0.5, y: 0.15, size: 0.07, color: '#ffffff', start: t, end: Math.min(duration, t + 3) }] }); setSelText(id); }}>Add text</button>
          <button className="btn icon" disabled={!h.canUndo} onClick={h.undo} aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
          <button className="btn icon" disabled={!h.canRedo} onClick={h.redo} aria-label="Redo" title="Redo (Ctrl+Y)">↷</button>
        </div>
        <Timeline p={p} t={t} filmstrip={loaded.filmstrip} selSeg={selSeg} selText={selText} onSeek={(x) => { pause(); seek(x); }}
          onSelectSeg={(id) => { setSelSeg(id); setSelText(null); }} onSelectText={(id) => { setSelText(id); setSelSeg(null); }}
          onTrim={(edge, src) => h.set(edge === 'start' ? setTrimStart(p, src) : setTrimEnd(p, src), true)}
          onTextTime={(id, start, end) => setText(id, { start, end })} />
        <p className="hint">Space play/pause · S split · Delete remove · I/O trim to playhead · ←/→ frame step (Shift: 1s) · Ctrl+Z/Y undo/redo · drag the preview to reposition</p>
      </div>
      <aside className="inspector">
        <section>
          <h3>Framing</h3>
          <div className="seg-buttons" role="radiogroup" aria-label="Aspect ratio">
            {(['original', '16:9', '9:16', '1:1'] as AspectMode[]).map((a) => (
              <button key={a} role="radio" aria-checked={p.aspect === a} className={`btn ${p.aspect === a ? 'toggled' : ''}`} onClick={() => h.set({ ...p, aspect: a })}>{a === 'original' ? 'Original' : a}</button>
            ))}
          </div>
          <Slider label="Zoom" min={1} max={4} step={0.01} value={p.framing.zoom} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => h.set({ ...p, framing: { ...p.framing, zoom: v } }, true)} />
          <Slider label="Horizontal" min={-1} max={1} step={0.01} value={p.framing.offsetX} fmt={(v) => v.toFixed(2)} onChange={(v) => h.set({ ...p, framing: { ...p.framing, offsetX: v } }, true)} />
          <Slider label="Vertical" min={-1} max={1} step={0.01} value={p.framing.offsetY} fmt={(v) => v.toFixed(2)} onChange={(v) => h.set({ ...p, framing: { ...p.framing, offsetY: v } }, true)} />
          <button className="btn small" onClick={() => h.set({ ...p, framing: { zoom: 1, offsetX: 0, offsetY: 0 } })}>Reset framing</button>
        </section>
        <section>
          <h3>Audio</h3>
          {p.source.audioTracks.length === 0 ? <p className="muted">This clip has no audio.</p> : <>
            <TrackControl label={p.source.audioTracks[0] ?? 'Desktop'} volume={p.audio.desktopVolume} muted={p.audio.desktopMuted}
              onVolume={(v) => h.set({ ...p, audio: { ...p.audio, desktopVolume: v } }, true)} onMute={(m) => h.set({ ...p, audio: { ...p.audio, desktopMuted: m } })} />
            {hasMic ? <TrackControl label={p.source.audioTracks[1]} volume={p.audio.micVolume} muted={p.audio.micMuted}
              onVolume={(v) => h.set({ ...p, audio: { ...p.audio, micVolume: v } }, true)} onMute={(m) => h.set({ ...p, audio: { ...p.audio, micMuted: m } })} />
              : <p className="muted small">No separate microphone track in this clip.</p>}
          </>}
        </section>
        {textAt && (
          <section>
            <h3>Text</h3>
            <label className="field"><span>Text</span><textarea rows={2} value={textAt.text} onChange={(e) => setText(textAt.id, { text: e.target.value })} /></label>
            <Slider label="Size" min={0.02} max={0.25} step={0.005} value={textAt.size} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setText(textAt.id, { size: v })} />
            <Slider label="X" min={0} max={1} step={0.005} value={textAt.x} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setText(textAt.id, { x: v })} />
            <Slider label="Y" min={0} max={1} step={0.005} value={textAt.y} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setText(textAt.id, { y: v })} />
            <div className="row">
              <label className="field compact"><span>Color</span><input type="color" value={textAt.color} onChange={(e) => setText(textAt.id, { color: e.target.value })} /></label>
              <label className="field compact"><span>Start (s)</span><input type="number" step={0.1} min={0} max={duration} value={textAt.start.toFixed(1)} onChange={(e) => setText(textAt.id, { start: clamp(Number(e.target.value), 0, textAt.end) }, false)} /></label>
              <label className="field compact"><span>End (s)</span><input type="number" step={0.1} min={0} max={duration} value={textAt.end.toFixed(1)} onChange={(e) => setText(textAt.id, { end: clamp(Number(e.target.value), textAt.start, duration) }, false)} /></label>
            </div>
            <button className="btn small danger" onClick={() => { h.set({ ...p, texts: p.texts.filter((x) => x.id !== textAt.id) }); setSelText(null); }}>Delete text</button>
          </section>
        )}
        <section>
          <h3>Export</h3>
          <label className="field"><span>File name</span><input value={opts.fileName} onChange={(e) => setOpts({ ...opts, fileName: e.target.value })} /></label>
          <div className="row">
            <label className="field compact"><span>Resolution</span>
              <select value={opts.resolution} onChange={(e) => setOpts({ ...opts, resolution: e.target.value as any })}>
                <option value="original">Original</option><option value="1080p">1080p</option><option value="720p">720p</option>
              </select></label>
            <label className="field compact"><span>Frame rate</span>
              <select value={String(opts.fps)} onChange={(e) => setOpts({ ...opts, fps: e.target.value === 'source' ? 'source' : (Number(e.target.value) as 30 | 60) })}>
                <option value="source">Source ({Math.round(loaded.fps)})</option><option value="60">60</option><option value="30">30</option>
              </select></label>
            <label className="field compact"><span>Quality</span>
              <select value={opts.quality} onChange={(e) => setOpts({ ...opts, quality: e.target.value as any })}>
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="ultra">Ultra</option>
              </select></label>
          </div>
          <p className="muted small">{exportSize.width}×{exportSize.height} · {fmtTime(duration)} · H.264/AAC MP4 · saved to Clips\Exports</p>
          {job?.state === 'queued' || job?.state === 'running' ? (
            <div className="export-progress">
              <div className="meter big" role="progressbar" aria-valuenow={Math.round(job.progress * 100)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${job.progress * 100}%` }} /></div>
              <span>{job.state === 'queued' ? 'Waiting…' : `${Math.round(job.progress * 100)}%`}</span>
              <button className="btn" onClick={() => api.cancelExport(job.id)}>Cancel</button>
            </div>
          ) : <button className="btn primary wide" onClick={startExport}>Export MP4</button>}
          {job?.state === 'done' && job.outputPath && <p className="ok small">Exported. <button className="link" onClick={() => api.revealExport(job.outputPath!)}>Show in Explorer</button></p>}
          {job?.state === 'failed' && <p className="error-text small">Export failed: {job.error}</p>}
          {job?.state === 'cancelled' && <p className="muted small">Export cancelled. No file was written.</p>}
        </section>
      </aside>
    </div>
  );
}

function Slider({ label, min, max, step, value, fmt, onChange }: { label: string; min: number; max: number; step: number; value: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{fmt(value)}</output>
    </label>
  );
}

function TrackControl({ label, volume, muted, onVolume, onMute }: { label: string; volume: number; muted: boolean; onVolume: (v: number) => void; onMute: (m: boolean) => void }) {
  return (
    <div className="track">
      <button className={`btn small ${muted ? 'toggled danger' : ''}`} aria-pressed={muted} onClick={() => onMute(!muted)}>{muted ? 'Muted' : 'Mute'}</button>
      <Slider label={label} min={0} max={2} step={0.01} value={volume} fmt={(v) => `${Math.round(v * 100)}%`} onChange={onVolume} />
    </div>
  );
}

/** Preview of the output frame: same crop math as the exporter, rendered with CSS. */
function Preview({ p, t, videoUrl, videoRef, selText, onSelectText, onPan, onMoveText }: {
  p: EditProject; t: number; videoUrl: string; videoRef: React.RefObject<HTMLVideoElement>; selText: string | null;
  onSelectText: (id: string | null) => void; onPan: (dx: number, dy: number) => void; onMoveText: (id: string, x: number, y: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const canvas = canvasSize(p, 'original');
  const ar = canvas.width / canvas.height;
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth, H = el.clientHeight;
      setBox(W / H > ar ? { w: H * ar, h: H } : { w: W, h: W / ar });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ar]);
  const crop = cropRect(p);
  const scale = box.w / crop.w;
  const drag = useRef<{ x: number; y: number; id: string | null } | null>(null);

  const onDown = (e: React.PointerEvent, id: string | null) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, id };
    onSelectText(id);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY;
    if (d.id) {
      const tx = p.texts.find((x) => x.id === d.id);
      if (tx) onMoveText(d.id, clamp(tx.x + dx / box.w, 0, 1), clamp(tx.y + dy / box.h, 0, 1));
    } else {
      const freeX = (p.source.width - crop.w) / 2, freeY = (p.source.height - crop.h) / 2;
      onPan(freeX > 0 ? -(dx / scale) / freeX : 0, freeY > 0 ? -(dy / scale) / freeY : 0);
    }
  };

  return (
    <div className="preview-wrap" ref={wrap}>
      <div className="frame" style={{ width: box.w, height: box.h }} onPointerDown={(e) => onDown(e, null)} onPointerMove={onMove} onPointerUp={() => (drag.current = null)}>
        <video ref={videoRef} src={videoUrl} muted preload="auto" playsInline
          style={{ position: 'absolute', width: p.source.width * scale, height: p.source.height * scale, left: -crop.x * scale, top: -crop.y * scale }} />
        {p.texts.filter((x) => t >= x.start && t <= x.end && x.text.trim()).map((x) => (
          <div key={x.id} className={`overlay-text ${selText === x.id ? 'sel' : ''}`} onPointerDown={(e) => onDown(e, x.id)}
            style={{ left: `${x.x * 100}%`, top: `${x.y * 100}%`, fontSize: x.size * box.h, color: x.color, WebkitTextStroke: `${Math.max(1, (x.size * box.h) / 14)}px rgba(0,0,0,.85)` }}>
            {x.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Timeline({ p, t, filmstrip, selSeg, selText, onSeek, onSelectSeg, onSelectText, onTrim, onTextTime }: {
  p: EditProject; t: number; filmstrip: string | null; selSeg: string | null; selText: string | null; onSeek: (t: number) => void;
  onSelectSeg: (id: string) => void; onSelectText: (id: string) => void; onTrim: (edge: 'start' | 'end', src: number) => void;
  onTextTime: (id: string, start: number, end: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const duration = outputDuration(p);
  const srcDur = p.source.duration;
  const toT = (clientX: number) => { const r = ref.current!.getBoundingClientRect(); return clamp(((clientX - r.left) / r.width) * duration, 0, duration); };
  const pct = (v: number) => `${(v / duration) * 100}%`;

  const dragging = useRef<null | ((x: number) => void)>(null);
  const begin = (e: React.PointerEvent, fn: (x: number) => void) => {
    e.stopPropagation(); e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = fn;
  };
  const move = (e: React.PointerEvent) => dragging.current?.(e.clientX);
  const end = () => { dragging.current = null; };

  const trimDrag = (edge: 'start' | 'end') => {
    const seg = edge === 'start' ? p.segments[0] : p.segments[p.segments.length - 1];
    const r = ref.current!.getBoundingClientRect();
    const pxPerSec = r.width / duration;
    const startX = edge === 'start' ? r.left : r.right;
    const origin = edge === 'start' ? seg.start : seg.end;
    return (x: number) => onTrim(edge, clamp(origin + (x - startX) / pxPerSec, 0, srcDur));
  };

  let acc = 0;
  return (
    <div className="timeline" onPointerMove={move} onPointerUp={end}>
      <div className="ruler" ref={ref} onPointerDown={(e) => begin(e, (x) => onSeek(toT(x)))}>
        {p.segments.map((s, i) => {
          const left = acc; acc += s.end - s.start;
          return (
            <div key={s.id} className={`segment ${selSeg === s.id ? 'sel' : ''}`} style={{ left: pct(left), width: pct(s.end - s.start) }}
              onPointerDown={(e) => { onSelectSeg(s.id); begin(e, (x) => onSeek(toT(x))); onSeek(toT(e.clientX)); }}>
              {filmstrip && <div className="strip" style={{ backgroundImage: `url("${filmstrip}")`, backgroundSize: `${(srcDur / (s.end - s.start)) * 100}% 100%`, backgroundPosition: `${(s.start / Math.max(0.001, srcDur - (s.end - s.start))) * 100}% 0` }} />}
              {i === 0 && <div className="handle start" role="slider" aria-label="Trim start" aria-valuenow={s.start} tabIndex={0} onPointerDown={(e) => begin(e, trimDrag('start'))} />}
              {i === p.segments.length - 1 && <div className="handle end" role="slider" aria-label="Trim end" aria-valuenow={s.end} tabIndex={0} onPointerDown={(e) => begin(e, trimDrag('end'))} />}
            </div>
          );
        })}
        <div className="playhead" style={{ left: pct(t) }} />
      </div>
      <div className="text-lane">
        {p.texts.map((x) => (
          <div key={x.id} className={`text-bar ${selText === x.id ? 'sel' : ''}`} style={{ left: pct(x.start), width: pct(Math.max(0.05, x.end - x.start)) }}
            onPointerDown={(e) => {
              onSelectText(x.id);
              const r = ref.current!.getBoundingClientRect(), sx = e.clientX, len = x.end - x.start;
              begin(e, (cx) => { const s = clamp(x.start + ((cx - sx) / r.width) * duration, 0, duration - len); onTextTime(x.id, s, s + len); });
            }}>
            {x.text || 'Text'}
          </div>
        ))}
      </div>
    </div>
  );
}
