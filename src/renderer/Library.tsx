import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ClipView, fmtBytes, fmtDuration } from './api';
import type { Toast } from './App';
import { clickSelection, groupByDate, runBatch, Selection } from './libraryView';
import { Modal } from './Modal';
import type { CaptureStatus, RecoveryInfo } from '../shared/types';

type Sort = 'newest' | 'oldest' | 'longest' | 'title' | 'size';
type Kind = 'all' | 'capture' | 'export' | 'import';

export function Library({ onEdit, toast, status }: { onEdit: (id: string) => void; toast: (k: Toast['kind'], t: string) => void; status: CaptureStatus | null }) {
  const [clips, setClips] = useState<ClipView[] | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [favOnly, setFavOnly] = useState(false);
  const [kind, setKind] = useState<Kind>('all');
  const [selection, setSelection] = useState<Selection>({ checked: new Set(), anchor: null });
  const selected = selection.anchor;
  const selectOne = (id: string | null) => setSelection({ checked: new Set(id ? [id] : []), anchor: id });
  const [recovery, setRecovery] = useState<RecoveryInfo[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<ClipView[] | null>(null);
  const [bulkTag, setBulkTag] = useState('');

  const reload = () => api.clips().then(setClips);
  useEffect(() => {
    api.refreshClips().then(setClips);
    api.recovery().then(setRecovery).catch(() => {});
    const off = api.onEvent((e) => {
      if (e.type === 'library-changed') reload();
      if (e.type === 'clip-saved') setSelection((s) => (s.anchor ? s : { checked: new Set([(e.payload as any).id]), anchor: (e.payload as any).id }));
    });
    const onFocus = () => api.refreshClips().then(setClips);
    window.addEventListener('focus', onFocus);
    return () => { off(); window.removeEventListener('focus', onFocus); };
  }, []);

  const visible = useMemo(() => {
    if (!clips) return [];
    const q = query.trim().toLowerCase();
    const list = clips.filter((c) => (!favOnly || c.favorite) && (kind === 'all' || c.kind === kind) && (!q || c.title.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q))));
    const by: Record<Sort, (a: ClipView, b: ClipView) => number> = {
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
      oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
      longest: (a, b) => b.durationSec - a.durationSec,
      title: (a, b) => a.title.localeCompare(b.title),
      size: (a, b) => b.sizeBytes - a.sizeBytes,
    };
    return list.sort(by[sort]);
  }, [clips, query, sort, favOnly, kind]);
  const grouped = sort === 'newest' || sort === 'oldest';
  const groups = useMemo(() => (grouped ? groupByDate(visible, new Date()) : [{ label: '', clips: visible }]), [visible, grouped]);
  const order = useMemo(() => groups.flatMap((g) => g.clips.map((c) => c.id)), [groups]);
  // Batch actions only touch clips you can see, even if a filter hid some that were selected earlier.
  const picked = visible.filter((c) => selection.checked.has(c.id));

  const sel = clips?.find((c) => c.id === selected) ?? null;
  const patch = async (id: string, p: Partial<ClipView>) => { await api.updateClip(id, p); reload(); };

  const onGridKey = (e: React.KeyboardEvent) => {
    if (!order.length) return;
    const i = order.indexOf(selected ?? '');
    const move = (id: string) => (e.shiftKey ? setSelection((s) => ({ ...clickSelection(s, id, order, { shift: true }), anchor: s.anchor })) : selectOne(id));
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(order[Math.min(order.length - 1, i + 1)]); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(order[Math.max(0, i - 1)]); }
    if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection((s) => ({ checked: new Set(order), anchor: s.anchor ?? order[0] })); }
    if (e.key === 'Escape') selectOne(selected);
    if (e.key === 'Enter' && sel?.status === 'ok') onEdit(sel.id);
    if (e.key === 'Delete' && picked.length) setConfirmDelete(picked);
  };

  const batch = async (items: ClipView[], action: (c: ClipView) => Promise<unknown>, doneText: (n: number) => string) => {
    const r = await runBatch(items, action);
    if (r.failed.length) toast('error', `${r.failed.length} of ${items.length} failed: ${r.failed[0]}`);
    else toast('ok', doneText(r.done));
    reload();
  };
  const addBulkTag = () => {
    const t = bulkTag.trim().slice(0, 32);
    if (!t) return;
    setBulkTag('');
    batch(picked.filter((c) => !c.tags.includes(t)), (c) => api.updateClip(c.id, { tags: [...c.tags, t] }), (n) => `Tagged ${n} clip${n === 1 ? '' : 's'}`);
  };
  const deleteClips = async (deleteFile: boolean) => {
    const items = confirmDelete ?? [];
    setConfirmDelete(null);
    await batch(items, (c) => api.deleteClip(c.id, deleteFile), (n) => (deleteFile ? `Moved ${n} file${n === 1 ? '' : 's'} to the Recycle Bin` : `Removed ${n} clip${n === 1 ? '' : 's'} from the library`));
    selectOne(null);
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
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="Type of clip">
            <option value="all">All clips</option>
            <option value="capture">Captures</option>
            <option value="export">Exports</option>
            <option value="import">Imports</option>
          </select>
          <button className={`btn ${favOnly ? 'toggled' : ''}`} aria-pressed={favOnly} onClick={() => setFavOnly(!favOnly)}>★ Favorites</button>
          <div className="spacer" />
          <button className="btn" onClick={() => api.importClips().then(reload)}>Import…</button>
        </div>
        {picked.length > 1 && (
          <div className="bulk-bar" role="toolbar" aria-label="Selected clips">
            <strong>{picked.length} selected</strong>
            <button className="btn small" onClick={() => { const on = picked.some((c) => !c.favorite); batch(picked.filter((c) => c.favorite !== on), (c) => api.updateClip(c.id, { favorite: on }), (n) => `${on ? 'Favorited' : 'Unfavorited'} ${n} clip${n === 1 ? '' : 's'}`); }}>★ {picked.some((c) => !c.favorite) ? 'Favorite' : 'Unfavorite'}</button>
            <input placeholder="Add tag to all" aria-label="Add tag to all selected clips" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addBulkTag()} />
            <button className="btn small danger" onClick={() => setConfirmDelete(picked)}>Delete…</button>
            <div className="spacer" />
            <button className="btn small" onClick={() => selectOne(selected)}>Clear selection</button>
          </div>
        )}
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
              <div className="groups" role="listbox" aria-label="Clips" aria-multiselectable="true" tabIndex={0} onKeyDown={onGridKey}>
                {groups.map((g) => (
                  <div key={g.label || 'all'} role="group" aria-label={g.label || undefined}>
                    {g.label && <h3 className="group-title">{g.label}</h3>}
                    <div className="grid">
                      {g.clips.map((c) => (
                        <div key={c.id} role="option" aria-selected={selection.checked.has(c.id)} className={`card ${selection.checked.has(c.id) ? 'selected' : ''}`}
                          draggable={c.status === 'ok'} onDragStart={(e) => { e.preventDefault(); api.dragClip(c.id).catch((err) => toast('error', err.message)); }}
                          onClick={(e) => setSelection((s) => clickSelection(s, c.id, order, { ctrl: e.ctrlKey, shift: e.shiftKey }))} onDoubleClick={() => c.status === 'ok' && onEdit(c.id)}>
                          <div className="thumb">
                            {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" loading="lazy" draggable={false} /> : <div className="thumb-ph">{c.status === 'pending' ? 'Processing…' : c.status === 'missing' ? 'File missing' : c.status === 'corrupt' ? 'Unreadable' : ''}</div>}
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
                  </div>
                ))}
              </div>
            )}
      </section>
      <aside className="preview-panel" aria-label="Clip details">
        {sel ? <ClipDetails key={sel.id} clip={sel} toast={toast} onEdit={onEdit} onPatch={(p) => patch(sel.id, p)} onDelete={() => setConfirmDelete([sel])} />
          : <div className="empty small">Select a clip to preview it.</div>}
      </aside>
      {confirmDelete && (
        <Modal labelledBy="del-title" onClose={() => setConfirmDelete(null)}>
          <h3 id="del-title">{confirmDelete.length === 1 ? `Delete “${confirmDelete[0].title}”?` : `Delete ${confirmDelete.length} clips?`}</h3>
          <p>Moving {confirmDelete.length === 1 ? 'the file' : 'files'} to the Recycle Bin can be undone from Windows. Removing from the library leaves {confirmDelete.length === 1 ? 'the file' : 'files'} where {confirmDelete.length === 1 ? 'it is' : 'they are'}.</p>
          <div className="row end">
            <button className="btn" autoFocus onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button className="btn" onClick={() => deleteClips(false)}>Remove from library</button>
            <button className="btn danger" onClick={() => deleteClips(true)}>{confirmDelete.length === 1 ? 'Move file to Recycle Bin' : `Move ${confirmDelete.length} files to Recycle Bin`}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ClipDetails({ clip, toast, onEdit, onPatch, onDelete }: { clip: ClipView; toast: (k: Toast['kind'], t: string) => void; onEdit: (id: string) => void; onPatch: (p: Partial<ClipView>) => void; onDelete: () => void }) {
  const [title, setTitle] = useState(clip.title);
  const [tag, setTag] = useState('');
  useEffect(() => setTitle(clip.title), [clip.title]);
  const commitTitle = () => { const t = title.trim(); if (t && t !== clip.title) onPatch({ title: t }); else setTitle(clip.title); };
  const video = useRef<HTMLVideoElement>(null);
  const addTag = () => { const t = tag.trim(); if (t && !clip.tags.includes(t)) onPatch({ tags: [...clip.tags, t] }); setTag(''); };
  return (
    <div className="details">
      {clip.status === 'ok' ? <video ref={video} className="preview-video" src={clip.videoUrl} controls preload="metadata" />
        : <div className="preview-video ph">{clip.status === 'missing' ? 'The file was moved or deleted.' : clip.status === 'corrupt' ? 'This file could not be read.' : 'Processing…'}</div>}
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={commitTitle} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setTitle(clip.title); }} />
      </label>
      <dl className="meta">
        <dt>Created</dt><dd>{new Date(clip.createdAt).toLocaleString()}</dd>
        <dt>Duration</dt><dd>{fmtDuration(clip.durationSec)}</dd>
        {clip.pressMarkerSec !== undefined && <><dt>Saved at</dt><dd><button className="link" title="Jump to about where you pressed the hotkey" onClick={() => { if (video.current) video.current.currentTime = clip.pressMarkerSec!; }}>{fmtDuration(clip.pressMarkerSec)}</button></dd></>}
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
        <button className="btn" disabled={clip.status !== 'ok'} title="Copies the file, ready to paste into a chat or folder. You can also drag a clip out of the library." onClick={() => api.copyClip(clip.id).then(() => toast('ok', 'File copied. Paste it wherever you need it.')).catch((e) => toast('error', e.message))}>Copy file</button>
        <button className="btn danger" onClick={onDelete}>Delete…</button>
      </div>
    </div>
  );
}
