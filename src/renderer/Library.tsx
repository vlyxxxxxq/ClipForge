import { useEffect, useMemo, useState } from 'react';
import { api, ClipView, fmtBytes, fmtDuration } from './api';
import type { Toast } from './App';
import type { CaptureStatus, RecoveryInfo } from '../shared/types';

type Sort = 'newest' | 'oldest' | 'longest' | 'title' | 'size';

export function Library({ onEdit, toast, status }: { onEdit: (id: string) => void; toast: (k: Toast['kind'], t: string) => void; status: CaptureStatus | null }) {
  const [clips, setClips] = useState<ClipView[] | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [favOnly, setFavOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryInfo[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<ClipView | null>(null);

  const reload = () => api.clips().then(setClips);
  useEffect(() => {
    api.refreshClips().then(setClips);
    api.recovery().then(setRecovery).catch(() => {});
    const off = api.onEvent((e) => {
      if (e.type === 'library-changed') reload();
      if (e.type === 'clip-saved') setSelected((s) => s ?? (e.payload as any).id);
    });
    const onFocus = () => api.refreshClips().then(setClips);
    window.addEventListener('focus', onFocus);
    return () => { off(); window.removeEventListener('focus', onFocus); };
  }, []);

  const visible = useMemo(() => {
    if (!clips) return [];
    const q = query.trim().toLowerCase();
    const list = clips.filter((c) => (!favOnly || c.favorite) && (!q || c.title.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q))));
    const by: Record<Sort, (a: ClipView, b: ClipView) => number> = {
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
      oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
      longest: (a, b) => b.durationSec - a.durationSec,
      title: (a, b) => a.title.localeCompare(b.title),
      size: (a, b) => b.sizeBytes - a.sizeBytes,
    };
    return list.sort(by[sort]);
  }, [clips, query, sort, favOnly]);

  const sel = clips?.find((c) => c.id === selected) ?? null;
  const patch = async (id: string, p: Partial<ClipView>) => { await api.updateClip(id, p); reload(); };

  const onGridKey = (e: React.KeyboardEvent) => {
    if (!visible.length) return;
    const i = visible.findIndex((c) => c.id === selected);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setSelected(visible[Math.min(visible.length - 1, i + 1)].id); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setSelected(visible[Math.max(0, i - 1)].id); }
    if (e.key === 'Enter' && sel?.status === 'ok') onEdit(sel.id);
    if (e.key === 'Delete' && sel) setConfirmDelete(sel);
  };

  return (
    <div className="library">
      <section className="lib-main">
        {recovery.map((r) => (
          <div key={r.sessionDir} className="banner info">
            <span>The last capture session ended unexpectedly. {r.seconds}s of replay buffer was recovered.</span>
            <button className="btn primary" onClick={async () => { try { await api.recover(r.sessionDir); toast('ok', 'Recovered clip saved'); } catch (e: any) { toast('error', e.message); } setRecovery(await api.recovery()); }}>Save as clip</button>
            <button className="btn" onClick={async () => { await api.discardRecovery(r.sessionDir); setRecovery(await api.recovery()); }}>Discard</button>
          </div>
        ))}
        <div className="toolbar">
          <input type="search" placeholder="Search titles and tags" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search clips" />
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="longest">Longest</option>
            <option value="size">Largest</option>
            <option value="title">Title A–Z</option>
          </select>
          <button className={`btn ${favOnly ? 'toggled' : ''}`} aria-pressed={favOnly} onClick={() => setFavOnly(!favOnly)}>★ Favorites</button>
          <div className="spacer" />
          <button className="btn" onClick={() => api.importClips().then(reload)}>Import…</button>
        </div>
        {clips === null ? <div className="empty">Loading library…</div>
          : clips.length === 0 ? (
            <div className="empty">
              <h2>No clips yet</h2>
              <p>{status?.state === 'recording'
                ? <>Capture is running. Press <kbd>{status.hotkey}</kbd> to save the last {status.replayDuration} seconds.</>
                : <>Start background capture, play something, then press <kbd>{status?.hotkey ?? 'F8'}</kbd> to save what just happened.</>}</p>
              {status?.state !== 'recording' && <button className="btn primary" onClick={() => api.start()}>Start capture</button>}
            </div>
          ) : visible.length === 0 ? <div className="empty"><p>No clips match your filters.</p></div>
            : (
              <div className="grid" role="listbox" aria-label="Clips" tabIndex={0} onKeyDown={onGridKey}>
                {visible.map((c) => (
                  <div key={c.id} role="option" aria-selected={c.id === selected} className={`card ${c.id === selected ? 'selected' : ''}`}
                    onClick={() => setSelected(c.id)} onDoubleClick={() => c.status === 'ok' && onEdit(c.id)}>
                    <div className="thumb">
                      {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" loading="lazy" /> : <div className="thumb-ph">{c.status === 'pending' ? 'Processing…' : c.status === 'missing' ? 'File missing' : c.status === 'corrupt' ? 'Unreadable' : ''}</div>}
                      <span className="badge">{fmtDuration(c.durationSec)}</span>
                      {c.kind === 'export' && <span className="badge left">Export</span>}
                      {c.status !== 'ok' && c.status !== 'pending' && <span className="badge left danger">{c.status}</span>}
                    </div>
                    <div className="card-body">
                      <div className="card-title" title={c.title}>{c.title}</div>
                      <button className={`star ${c.favorite ? 'on' : ''}`} aria-label={c.favorite ? 'Remove favorite' : 'Add favorite'} onClick={(e) => { e.stopPropagation(); patch(c.id, { favorite: !c.favorite }); }}>★</button>
                    </div>
                    <div className="card-meta">{new Date(c.createdAt).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            )}
      </section>
      <aside className="preview-panel" aria-label="Clip details">
        {sel ? <ClipDetails key={sel.id} clip={sel} onEdit={onEdit} onPatch={(p) => patch(sel.id, p)} onDelete={() => setConfirmDelete(sel)} />
          : <div className="empty small">Select a clip to preview it.</div>}
      </aside>
      {confirmDelete && (
        <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="del-title">
          <div className="modal">
            <h3 id="del-title">Delete “{confirmDelete.title}”?</h3>
            <p>Moving the file to the Recycle Bin can be undone from Windows. Removing from the library leaves the file where it is.</p>
            <div className="row end">
              <button className="btn" autoFocus onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn" onClick={async () => { await api.deleteClip(confirmDelete.id, false); setConfirmDelete(null); setSelected(null); reload(); }}>Remove from library</button>
              <button className="btn danger" onClick={async () => { try { await api.deleteClip(confirmDelete.id, true); } catch (e: any) { toast('error', e.message); } setConfirmDelete(null); setSelected(null); reload(); }}>Move file to Recycle Bin</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ClipDetails({ clip, onEdit, onPatch, onDelete }: { clip: ClipView; onEdit: (id: string) => void; onPatch: (p: Partial<ClipView>) => void; onDelete: () => void }) {
  const [title, setTitle] = useState(clip.title);
  const [tag, setTag] = useState('');
  useEffect(() => setTitle(clip.title), [clip.title]);
  const commitTitle = () => { const t = title.trim(); if (t && t !== clip.title) onPatch({ title: t }); else setTitle(clip.title); };
  const addTag = () => { const t = tag.trim(); if (t && !clip.tags.includes(t)) onPatch({ tags: [...clip.tags, t] }); setTag(''); };
  return (
    <div className="details">
      {clip.status === 'ok' ? <video className="preview-video" src={clip.videoUrl} controls preload="metadata" />
        : <div className="preview-video ph">{clip.status === 'missing' ? 'The file was moved or deleted.' : clip.status === 'corrupt' ? 'This file could not be read.' : 'Processing…'}</div>}
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={commitTitle} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setTitle(clip.title); }} />
      </label>
      <dl className="meta">
        <dt>Created</dt><dd>{new Date(clip.createdAt).toLocaleString()}</dd>
        <dt>Duration</dt><dd>{fmtDuration(clip.durationSec)}</dd>
        <dt>Resolution</dt><dd>{clip.width ? `${clip.width}×${clip.height} @ ${Math.round(clip.fps)} fps` : '—'}</dd>
        <dt>Size</dt><dd>{fmtBytes(clip.sizeBytes)}</dd>
        <dt>Audio</dt><dd>{clip.audioTracks.length ? clip.audioTracks.join(', ') : 'None'}</dd>
        <dt>File</dt><dd className="path" title={clip.filePath}>{clip.filePath}</dd>
      </dl>
      <div className="tags">
        {clip.tags.map((t) => <span key={t} className="tag">{t}<button aria-label={`Remove tag ${t}`} onClick={() => onPatch({ tags: clip.tags.filter((x) => x !== t) })}>×</button></span>)}
        <input placeholder="Add tag" value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTag()} aria-label="Add tag" />
      </div>
      <div className="row wrap">
        <button className="btn primary" disabled={clip.status !== 'ok'} onClick={() => onEdit(clip.id)}>Open in editor</button>
        <button className={`btn ${clip.favorite ? 'toggled' : ''}`} onClick={() => onPatch({ favorite: !clip.favorite })}>★ {clip.favorite ? 'Favorited' : 'Favorite'}</button>
        {clip.status === 'missing' ? <button className="btn" onClick={() => api.relink(clip.id)}>Locate file…</button>
          : <button className="btn" onClick={() => api.reveal(clip.id)}>Show in Explorer</button>}
        <button className="btn danger" onClick={onDelete}>Delete…</button>
      </div>
    </div>
  );
}
