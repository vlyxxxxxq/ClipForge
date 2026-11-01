import { useEffect, useState } from 'react';
import { api, fmtDuration } from './api';
import { Field, HotkeyInput } from './CapturePage';
import { Modal } from './Modal';
import type { Toast } from './App';
import type { AudioDevice, CaptureSettings, CaptureStatus, GeneralSettings, MonitorInfo, Settings } from '../shared/types';

/** First-run setup. Skippable. Recording starts when it's finished, or from Start capture on the test step. */
export function Setup({ settings, status, onSettings, onDone, toast }: {
  settings: Settings; status: CaptureStatus | null; onSettings: (s: Settings) => Promise<unknown>; onDone: () => void; toast: (k: Toast['kind'], t: string) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [dev, setDev] = useState<{ monitors: MonitorInfo[]; audio: AudioDevice[] } | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const c = settings.capture;
  const setC = (patch: Partial<CaptureSettings>) => onSettings({ ...settings, capture: { ...c, ...patch } });
  const setG = (patch: Partial<GeneralSettings>) => onSettings({ ...settings, general: { ...settings.general, ...patch } });
  const run = (f: () => Promise<unknown>) => f().catch((e) => toast('error', e.message));

  useEffect(() => { api.devices().then(setDev).catch((e) => toast('error', e.message)); }, []);
  useEffect(() => api.onEvent((e) => {
    if (e.type === 'clip-saved') { setSaved((e.payload as { durationSec: number }).durationSec); setSaving(false); }
    if (e.type === 'clip-save-failed') setSaving(false);
  }), []);

  const mics = dev?.audio.filter((d) => d.kind === 'capture') ?? [];
  const recording = status?.state === 'recording';
  const buffered = status?.bufferedSeconds ?? 0;

  return (
    <Modal labelledBy="setup-title" onClose={onDone} wide>
      <h3 id="setup-title">{step === 1 ? 'Set up ClipForge' : 'Save a test clip'}</h3>
      {step === 1 ? (
        <div className="setup-body">
          <Field label="Display to capture" hint="Borderless and windowed games work best.">
            <select value={c.monitorIndex} onChange={(e) => setC({ monitorIndex: Number(e.target.value) })}>
              {dev?.monitors.map((m) => <option key={m.index} value={m.index}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Record desktop audio"><input type="checkbox" checked={c.desktopAudio} onChange={(e) => setC({ desktopAudio: e.target.checked })} /></Field>
          <Field label="Record your microphone" hint="Kept on its own track, so you can balance or mute it later."><input type="checkbox" checked={c.micEnabled} onChange={(e) => setC({ micEnabled: e.target.checked })} /></Field>
          {c.micEnabled && (
            <Field label="Microphone">
              <select value={c.micDeviceId ?? ''} onChange={(e) => setC({ micDeviceId: e.target.value || null })}>
                <option value="">System default</option>
                {mics.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Save clip hotkey"><HotkeyInput value={c.hotkey} onChange={(hk) => setC({ hotkey: hk })} /></Field>
          <Field label="Clips folder">
            <div className="row"><input readOnly value={c.clipsDir} aria-label="Clips folder" /><button className="btn" onClick={async () => { const f = await api.pickFolder(); if (f) setC({ clipsDir: f }); }}>Browse…</button></div>
          </Field>
          <Field label="Keep the replay buffer on" hint="Your screen is recorded to a temporary buffer on this PC whenever ClipForge runs, so you never miss a clip. Nothing is uploaded."><input type="checkbox" checked={c.autoStartCapture} onChange={(e) => setC({ autoStartCapture: e.target.checked })} /></Field>
          <Field label="Start with Windows" hint="Runs in the tray from when you sign in."><input type="checkbox" checked={settings.general.launchAtLogin} onChange={(e) => setG({ launchAtLogin: e.target.checked })} /></Field>
          <Field label="Play a sound when a clip saves" hint="So you know it worked without leaving your game."><input type="checkbox" checked={settings.general.saveSound} onChange={(e) => setG({ saveSound: e.target.checked })} /></Field>
        </div>
      ) : (
        <div className="setup-body">
          <p className="muted">Start capture, wait a few seconds, then save. Your clip will be in the library. You can also press <kbd>{status?.hotkey ?? c.hotkey}</kbd> instead of the button.</p>
          <div className="row">
            <button className="btn" disabled={recording || status?.state === 'starting'} onClick={() => run(api.start)}>{status?.state === 'starting' ? 'Starting…' : recording ? 'Capture is running' : 'Start capture'}</button>
            <button className="btn primary" disabled={!recording || buffered < 4 || saving} onClick={() => { setSaving(true); run(api.save); }}>{saving ? 'Saving…' : 'Save test clip'}</button>
            {recording && <span className="muted small">{buffered}s buffered</span>}
          </div>
          {status?.lastError && <div className="banner error">{status.lastError}</div>}
          {saved !== null && <p className="ok">Saved a {fmtDuration(saved)} clip. It's in your library.</p>}
          {recording && <p className="muted small">Capture keeps running until you stop it in the top bar.</p>}
        </div>
      )}
      <div className="row end">
        <button className="btn" onClick={onDone}>{step === 2 && saved !== null ? 'Close' : 'Skip'}</button>
        {step === 1 && <button className="btn primary" onClick={() => setStep(2)}>Next</button>}
        {step === 2 && saved !== null && <button className="btn primary" onClick={onDone}>Done</button>}
      </div>
    </Modal>
  );
}
