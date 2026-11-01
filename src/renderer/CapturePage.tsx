import { useEffect, useState } from 'react';
import { api, fmtBytes } from './api';
import type { Toast } from './App';
import { REPLAY_DURATIONS, type AudioDevice, type CaptureSettings, type CaptureStatus, type EncoderInfo, type MonitorInfo, type Settings } from '../shared/types';

export function CapturePage({ settings, status, onSettings, toast }: { settings: Settings; status: CaptureStatus | null; onSettings: (s: Settings) => Promise<unknown>; toast: (k: Toast['kind'], t: string) => void }) {
  const [dev, setDev] = useState<{ monitors: MonitorInfo[]; audio: AudioDevice[]; encoders: EncoderInfo[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const c = settings.capture;
  const set = (patch: Partial<CaptureSettings>) => onSettings({ ...settings, capture: { ...c, ...patch } });
  const load = (refresh = false) => { setLoading(true); api.devices(refresh).then(setDev).catch((e) => toast('error', e.message)).finally(() => setLoading(false)); };
  useEffect(() => load(), []);

  const renders = dev?.audio.filter((d) => d.kind === 'render') ?? [];
  const mics = dev?.audio.filter((d) => d.kind === 'capture') ?? [];
  const missing = (id: string | null, list: AudioDevice[]) => id && dev && !list.some((d) => d.id === id);

  return (
    <div className="settings-page">
      <h1>Capture</h1>
      {status && (
        <section className="card-section diag" aria-label="Capture diagnostics">
          <h2>Status</h2>
          <dl className="meta wide">
            <dt>State</dt><dd>{status.state}</dd>
            <dt>Encoder</dt><dd>{status.encoder ?? '—'}{status.encoderFallbackReason && <span className="warn-text"> — {status.encoderFallbackReason}</span>}</dd>
            <dt>Measured FPS</dt><dd>{status.fps?.toFixed(1) ?? '—'} {status.speed !== null && status.speed < 0.97 && status.state === 'recording' && <span className="warn-text">(encoder falling behind: {status.speed.toFixed(2)}×)</span>}</dd>
            <dt>Dropped frames</dt><dd>{status.droppedFrames}</dd>
            <dt>Audio tracks</dt><dd>{status.audioTracks.length ? status.audioTracks.join(', ') : 'none'}</dd>
            <dt>Hotkey</dt><dd>{status.hotkey} {status.hotkeyRegistered ? '(registered)' : <span className="error-text">— {status.hotkeyError ?? 'not registered'}</span>}</dd>
            <dt>Free disk</dt><dd>{status.freeDiskBytes !== null ? fmtBytes(status.freeDiskBytes) : '—'}</dd>
          </dl>
          {status.lastError && <div className="banner error" role="alert">{status.lastError}</div>}
          {status.warnings.map((w) => <div key={w} className="banner warn">{w}</div>)}
          <button className="btn small" onClick={() => api.openLogs()}>Open log folder</button>
        </section>
      )}
      <section className="card-section">
        <h2>Replay</h2>
        <Field label="Replay length">
          <select value={c.replayDuration} onChange={(e) => set({ replayDuration: Number(e.target.value) as any })}>{REPLAY_DURATIONS.map((d) => <option key={d} value={d}>{d} seconds</option>)}</select>
        </Field>
        <Field label="Save clip hotkey" hint="Global shortcut, works while games have focus. If another app owns it, you'll see a warning.">
          <HotkeyInput value={c.hotkey} onChange={(hk) => set({ hotkey: hk })} />
        </Field>
        {REPLAY_DURATIONS.map((d) => (
          <Field key={d} label={`Save the last ${d} seconds`}>
            <OptionalHotkey value={c.durationHotkeys[d] ?? null} onChange={(hk) => {
              const { [d]: _old, ...rest } = c.durationHotkeys;
              set({ durationHotkeys: hk ? { ...rest, [d]: hk } : rest });
            }} />
          </Field>
        ))}
        <Field label="Screenshot hotkey" hint="Saves a PNG of the selected display to the Screenshots folder in your clips folder.">
          <div className="row"><button className="btn small" onClick={() => api.screenshot()}>Take one now</button><OptionalHotkey value={c.screenshotHotkey} onChange={(hk) => set({ screenshotHotkey: hk })} /></div>
        </Field>
        {status?.hotkeyWarnings.map((w) => <div key={w} className="banner warn">{w}</div>)}
        <p className="muted small">Using a length longer than your replay length keeps more footage in the buffer, which uses more disk space.</p>
        <Field label="Clips folder">
          <div className="row"><input readOnly value={c.clipsDir} /><button className="btn" onClick={async () => { const f = await api.pickFolder(); if (f) set({ clipsDir: f }); }}>Browse…</button></div>
        </Field>
        <Field label="Start capture when ClipForge opens"><input type="checkbox" checked={c.autoStartCapture} onChange={(e) => set({ autoStartCapture: e.target.checked })} /></Field>
      </section>
      <section className="card-section">
        <h2>Video <button className="btn small" disabled={loading} onClick={() => load(true)}>{loading ? 'Detecting…' : 'Re-detect'}</button></h2>
        <Field label="Source" hint="Captures a whole display with Windows Desktop Duplication. Borderless/windowed games work best; some exclusive-fullscreen games may show black frames.">
          <select value={c.monitorIndex} onChange={(e) => set({ monitorIndex: Number(e.target.value) })}>
            {dev?.monitors.map((m) => <option key={m.index} value={m.index}>{m.label}</option>)}
            {dev && !dev.monitors.some((m) => m.index === c.monitorIndex) && <option value={c.monitorIndex}>Display {c.monitorIndex + 1} (not found)</option>}
          </select>
        </Field>
        <Field label="Resolution">
          <select value={c.resolution} onChange={(e) => set({ resolution: e.target.value as any })}>
            <option value="native">Native</option><option value="1440p">1440p</option><option value="1080p">1080p</option><option value="720p">720p</option>
          </select>
        </Field>
        <Field label="Frame rate">
          <select value={c.fps} onChange={(e) => set({ fps: Number(e.target.value) as any })}><option value={60}>60 fps</option><option value={30}>30 fps</option></select>
        </Field>
        <Field label="Quality">
          <select value={c.quality} onChange={(e) => set({ quality: e.target.value as any })}>
            <option value="low">Low (smaller files)</option><option value="medium">Medium</option><option value="high">High</option><option value="ultra">Ultra</option>
          </select>
        </Field>
        <Field label="Encoder" hint="Each encoder is tested by encoding real frames; unavailable ones are disabled.">
          <select value={c.encoder} onChange={(e) => set({ encoder: e.target.value as any })}>
            <option value="auto">Automatic (prefer hardware)</option>
            {dev?.encoders.map((e) => <option key={e.id} value={e.id} disabled={!e.available}>{e.label}{e.available ? '' : ' — unavailable'}</option>)}
          </select>
        </Field>
      </section>
      <section className="card-section">
        <h2>Audio</h2>
        <Field label="Desktop audio"><input type="checkbox" checked={c.desktopAudio} onChange={(e) => set({ desktopAudio: e.target.checked })} /></Field>
        {c.desktopAudio && <>
          <Field label="Output device" hint={missing(c.desktopDeviceId, renders) ? 'The selected device is not connected; capture will skip it.' : undefined}>
            <select value={c.desktopDeviceId ?? ''} onChange={(e) => set({ desktopDeviceId: e.target.value || null })}>
              <option value="">System default</option>
              {renders.map((d) => <option key={d.id} value={d.id}>{d.name}{d.isDefault ? ' (default)' : ''}</option>)}
            </select>
          </Field>
          <Field label={`Desktop volume ${Math.round(c.desktopVolume * 100)}%`}><input type="range" min={0} max={2} step={0.05} value={c.desktopVolume} onChange={(e) => set({ desktopVolume: Number(e.target.value) })} /></Field>
        </>}
        <Field label="Microphone" hint="Recorded as a separate track so it can be balanced in the editor."><input type="checkbox" checked={c.micEnabled} onChange={(e) => set({ micEnabled: e.target.checked })} /></Field>
        {c.micEnabled && <>
          <Field label="Input device" hint={missing(c.micDeviceId, mics) ? 'The selected microphone is not connected; capture will skip it.' : undefined}>
            <select value={c.micDeviceId ?? ''} onChange={(e) => set({ micDeviceId: e.target.value || null })}>
              <option value="">System default</option>
              {mics.map((d) => <option key={d.id} value={d.id}>{d.name}{d.isDefault ? ' (default)' : ''}</option>)}
            </select>
          </Field>
          <Field label={`Microphone volume ${Math.round(c.micVolume * 100)}%`}><input type="range" min={0} max={2} step={0.05} value={c.micVolume} onChange={(e) => set({ micVolume: Number(e.target.value) })} /></Field>
        </>}
        <p className="muted small">Changing video or audio settings restarts capture; the current replay buffer is discarded.</p>
      </section>
    </div>
  );
}

function OptionalHotkey({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return <div className="row"><HotkeyInput value={value} onChange={onChange} />{value && <button className="btn small" onClick={() => onChange(null)}>Clear</button>}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-label"><span>{label}</span>{hint && <small>{hint}</small>}</div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function HotkeyInput({ value, onChange }: { value: string | null; onChange: (v: string) => void }) {
  const [rec, setRec] = useState(false);
  const onKey = (e: React.KeyboardEvent) => {
    if (!rec) return;
    e.preventDefault();
    if (e.key === 'Escape') return setRec(false);
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key === ' ' ? 'Space' : e.key.replace(/^Arrow/, '');
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    onChange([...mods, key].join('+'));
    setRec(false);
  };
  return <button className={`btn hotkey ${rec ? 'recording' : ''}`} onClick={() => setRec(true)} onKeyDown={onKey} onBlur={() => setRec(false)}>
    {rec ? 'Press a key… (Esc to cancel)' : value ? <kbd>{value}</kbd> : 'Not set'}
  </button>;
}
