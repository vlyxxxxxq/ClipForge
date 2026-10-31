import { useEffect, useState } from 'react';
import { api } from './api';
import { Field } from './CapturePage';
import type { GeneralSettings, Settings } from '../shared/types';

export function GeneralPage({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => Promise<unknown> }) {
  const g = settings.general;
  const set = (patch: Partial<GeneralSettings>) => onSettings({ ...settings, general: { ...g, ...patch } });
  const [info, setInfo] = useState<{ version: string; logFile: string | null } | null>(null);
  useEffect(() => { api.info().then(setInfo); }, []);
  return (
    <div className="settings-page">
      <h1>Settings</h1>
      <section className="card-section">
        <h2>Window</h2>
        <Field label="Closing the window keeps ClipForge running in the tray" hint="Capture continues in the background. Quit from the tray menu."><input type="checkbox" checked={g.closeToTray} onChange={(e) => set({ closeToTray: e.target.checked })} /></Field>
        <Field label="Start hidden when launched with --hidden"><input type="checkbox" checked={g.launchMinimized} onChange={(e) => set({ launchMinimized: e.target.checked })} /></Field>
      </section>
      <section className="card-section">
        <h2>Notifications</h2>
        <Field label="Show a notification when a clip is saved"><input type="checkbox" checked={g.notifyOnSave} onChange={(e) => set({ notifyOnSave: e.target.checked })} /></Field>
      </section>
      <section className="card-section">
        <h2>Storage</h2>
        <p className="muted">ClipForge never deletes your clips automatically. Only the temporary replay buffer is cleaned up, and only inside ClipForge’s own data folder.</p>
        <button className="btn small" onClick={() => api.openLogs()}>Open log folder</button>
      </section>
      <section className="card-section">
        <h2>About</h2>
        <p className="muted">ClipForge {info?.version} · Uses FFmpeg (LGPL/GPL) and NAudio (MIT).</p>
      </section>
    </div>
  );
}
