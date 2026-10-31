import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Library } from './Library';
import { Editor } from './Editor';
import { CapturePage } from './CapturePage';
import { GeneralPage } from './GeneralPage';
import { REPLAY_DURATIONS, type CaptureStatus, type Settings } from '../shared/types';

export type Page = 'library' | 'editor' | 'capture' | 'general';
export interface Toast { id: number; kind: 'ok' | 'error' | 'info'; text: string }

let toastId = 0;

export function App() {
  const [page, setPage] = useState<Page>('library');
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);

  useEffect(() => {
    api.status().then(setStatus);
    api.getSettings().then(setSettings);
    api.info().then((i) => setMediaError(i.mediaError));
    const offS = api.onStatus(setStatus);
    const offE = api.onEvent((e) => {
      if (e.type === 'clip-saved') toast('ok', `Clip saved (${Math.round((e.payload as any).durationSec)}s)`);
      if (e.type === 'clip-save-failed') toast('error', `Clip not saved: ${e.payload}`);
    });
    return () => { offS(); offE(); };
  }, [toast]);

  const updateSettings = useCallback(async (s: Settings) => {
    const r = await api.setSettings(s);
    setSettings(r.settings);
    if (!r.hotkey.ok && r.hotkey.error) toast('error', r.hotkey.error);
    return r;
  }, [toast]);

  const openEditor = (id: string) => { setEditing(id); setPage('editor'); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const map: Record<string, Page> = { '1': 'library', '2': 'editor', '3': 'capture', '4': 'general' };
      if (map[e.key]) { e.preventDefault(); setPage(map[e.key]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><span className="brand-mark" aria-hidden />ClipForge</div>
        {([['library', 'Library', 'Ctrl+1'], ['editor', 'Editor', 'Ctrl+2'], ['capture', 'Capture', 'Ctrl+3'], ['general', 'Settings', 'Ctrl+4']] as const).map(([id, label, key]) => (
          <button key={id} className={`nav ${page === id ? 'active' : ''}`} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined} title={key}>
            {label}
          </button>
        ))}
        <div className="sidebar-foot">{status && <StatusPill status={status} />}</div>
      </nav>
      <main className="content">
        <CaptureBar status={status} settings={settings} onSettings={updateSettings} toast={toast} onOpenCapture={() => setPage('capture')} />
        {mediaError && <div className="banner error" role="alert">{mediaError}</div>}
        <div className="page">
          {page === 'library' && <Library onEdit={openEditor} toast={toast} status={status} />}
          {page === 'editor' && <Editor clipId={editing} toast={toast} onBack={() => setPage('library')} />}
          {page === 'capture' && settings && <CapturePage settings={settings} status={status} onSettings={updateSettings} toast={toast} />}
          {page === 'general' && settings && <GeneralPage settings={settings} onSettings={updateSettings} />}
        </div>
      </main>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: CaptureStatus }) {
  const label = { stopped: 'Capture off', starting: 'Starting…', recording: 'Recording', paused: 'Paused', error: 'Error' }[status.state];
  return <div className={`pill ${status.state}`}><span className="dot" aria-hidden />{label}</div>;
}

function CaptureBar({ status, settings, onSettings, toast, onOpenCapture }: {
  status: CaptureStatus | null; settings: Settings | null; onSettings: (s: Settings) => Promise<unknown>; toast: (k: Toast['kind'], t: string) => void; onOpenCapture: () => void;
}) {
  if (!status || !settings) return <header className="capturebar" />;
  const active = status.state === 'recording' || status.state === 'starting';
  const canSave = status.state === 'recording' || status.state === 'paused';
  const run = (f: () => Promise<unknown>) => f().catch((e) => toast('error', e.message));
  return (
    <header className="capturebar">
      <StatusPill status={status} />
      <div className="buffer-meter" title="Seconds currently held in the replay buffer">
        <div className="meter"><div style={{ width: `${Math.min(100, (status.bufferedSeconds / status.replayDuration) * 100)}%` }} /></div>
        <span>{Math.min(status.bufferedSeconds, status.replayDuration)}s / {status.replayDuration}s</span>
      </div>
      <label className="inline">
        <span className="sr-only">Replay duration</span>
        <select value={settings.capture.replayDuration} onChange={(e) => onSettings({ ...settings, capture: { ...settings.capture, replayDuration: Number(e.target.value) as any } })}>
          {REPLAY_DURATIONS.map((d) => <option key={d} value={d}>Last {d}s</option>)}
        </select>
      </label>
      <div className="spacer" />
      {status.state === 'error' && <button className="link danger" onClick={onOpenCapture}>{status.lastError?.slice(0, 80)}</button>}
      {status.state === 'stopped' || status.state === 'error'
        ? <button className="btn" onClick={() => run(api.start)}>Start capture</button>
        : <>
          {status.state === 'paused' ? <button className="btn" onClick={() => run(api.resume)}>Resume</button>
            : <button className="btn" disabled={!active} onClick={() => run(api.pause)}>Pause</button>}
          <button className="btn" onClick={() => run(api.stop)}>Stop</button>
        </>}
      <button className="btn primary" disabled={!canSave || status.savingCount > 0} onClick={() => run(api.save)} title={status.hotkeyRegistered ? `Global hotkey: ${status.hotkey}` : status.hotkeyError ?? ''}>
        {status.savingCount > 0 ? 'Saving…' : 'Save clip'} <kbd>{status.hotkey}</kbd>
      </button>
      {!status.hotkeyRegistered && status.hotkeyError && <span className="warn-dot" title={status.hotkeyError} aria-label={status.hotkeyError}>!</span>}
    </header>
  );
}
