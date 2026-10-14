import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, openFile, uploadFile, undo, redo, setFilesOpen, fail } from '../store';
import { api, type FileEntry } from '../api';
import { fmtShort, fmtShortMs, fmtBytes } from '../util';
import { NewProjectForm } from './NewProject';

export function TopBar() {
  const s = useApp();
  const snap = s.snapshot;
  const canUndo = !!snap && (!s.history || s.history.undo.length > 0);
  const canRedo = !!snap && (!s.history || s.history.redo.length > 0);
  const undoTip = s.history?.undo[0] ? `Undo: ${s.history.undo[0]}` : 'Undo';
  const redoTip = s.history?.redo[0] ? `Redo: ${s.history.redo[0]}` : 'Redo';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      e.preventDefault();
      if (e.shiftKey) { if (canRedo) redo(); } else if (canUndo) undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canUndo, canRedo]);

  const warn = snap?.warnings.length ?? 0;
  return (
    <div class="topbar">
      <div class="tb-left">
        <span class="brand"><span class="logo" />Schedule Composer</span>
        <FilePicker />
        {snap && snap.changedSinceLoad > 0 && <span class="changes" title="Edits since the file was loaded">{snap.changedSinceLoad} change{snap.changedSinceLoad === 1 ? '' : 's'}</span>}
      </div>
      <div class="tb-mid mono">
        {snap && (
          <>
            <span>Data date {fmtShort(snap.project.dataDate)}</span>
            <span class="dot-sep">·</span>
            <span title={snap.project.finish}>Finish <span class={`fin flash-${s.finishFlash ?? 'none'}`}>{fmtShort(snap.project.finish) || '—'}</span></span>
            <span class="dot-sep">·</span>
            <span>{snap.tasks.length} activit{snap.tasks.length === 1 ? 'y' : 'ies'}</span>
            {warn > 0 && <><span class="dot-sep">·</span><span class="warn" title={snap.warnings.join('\n')}>{warn} warning{warn === 1 ? '' : 's'}</span></>}
          </>
        )}
      </div>
      <div class="tb-right">
        <button class="tb ghost" title={`${undoTip} (⌘Z)`} disabled={!canUndo} onClick={undo}>
          <svg viewBox="0 0 16 16" class="ico"><path d="M6 4L2.5 7.5 6 11" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M3 7.5h6.5a3.5 3.5 0 0 1 0 7H8" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>Undo
        </button>
        <button class="tb ghost" title={`${redoTip} (⇧⌘Z)`} disabled={!canRedo} onClick={redo}>
          Redo<svg viewBox="0 0 16 16" class="ico"><path d="M10 4l3.5 3.5L10 11" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M13 7.5H6.5a3.5 3.5 0 0 0 0 7H8" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
        </button>
        <a class={`tb ghost ${snap ? '' : 'disabled'}`} href={api.exportUrl()} download title="Download the schedule as an XER file">Export</a>
        <span class={`agent ${!s.online ? 'off' : s.working ? 'working' : 'idle'}`} title={!s.online ? 'Disconnected from server' : s.working ? 'Agent working' : 'Agent idle'}>
          <span class="dot" />{!s.online && 'offline'}
        </span>
      </div>
    </div>
  );
}

function FilePicker() {
  const s = useApp();
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const open = s.filesOpen;

  useEffect(() => {
    if (!open) { setCreating(false); return; }
    setFiles(null);
    api.files().then((r) => setFiles(r.files)).catch((e) => { setFiles([]); fail(e); });
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setFilesOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFilesOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const choose = async (path: string) => { setBusy(true); await openFile(path); setBusy(false); setFilesOpen(false); };
  const upload = async (f: File | undefined) => { if (!f) return; setBusy(true); await uploadFile(f); setBusy(false); setFilesOpen(false); };

  return (
    <div class="filepick" ref={ref}>
      <button class={`file-btn ${open ? 'on' : ''}`} onClick={() => setFilesOpen(!open)} title="Open, upload or start a schedule">
        <span class="name">{s.snapshot?.file ?? 'No file open'}</span>
        <span class="chev">▾</span>
      </button>
      {open && (
        <div class="menu files">
          {creating ? (
            <>
              <div class="menu-head"><span>New project</span></div>
              <NewProjectForm onDone={() => { setCreating(false); setFilesOpen(false); }} onCancel={() => setCreating(false)} />
            </>
          ) : (
            <>
              <button class="item new" onClick={() => setCreating(true)}>
                <span class="plus">+</span><span class="fname">New project…</span>
              </button>
              <div class="menu-sep" />
              {files === null && <div class="menu-empty">Loading…</div>}
              {files && files.length === 0 && <div class="menu-empty">Nothing in samples/ or data/uploads/ yet.</div>}
              {files?.map((f) => (
                <button key={f.path} class={`item ${s.snapshot?.file === f.name ? 'on' : ''}`} disabled={busy} onClick={() => choose(f.path)} title={f.path}>
                  <span class="fname">{f.name}</span>
                  <span class="fmeta">{fmtBytes(f.size)}</span>
                  <span class="fmeta mono">{mtime(f.mtime)}</span>
                </button>
              ))}
              <div class="menu-sep" />
              <button class="item" disabled={busy} onClick={() => input.current?.click()}><span class="plus">↑</span><span class="fname">Upload .xer…</span></button>
              <input ref={input} type="file" accept=".xer" style="display:none" onChange={(e) => upload((e.currentTarget as HTMLInputElement).files?.[0])} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function mtime(v: number | string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return fmtShortMs(d.getTime());
}
