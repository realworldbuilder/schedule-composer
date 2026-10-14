// "New project" form (POST /api/new) and the welcome page shown when no file is open.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, api, type FileEntry } from '../api';
import { newProject, openFile, uploadFile, fail } from '../store';
import { codeFromName, fmtBytes, nextMondayISO } from '../util';

const DAYS: [number, string][] = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

export function NewProjectForm({ onDone, onCancel, autoFocus = true }: { onDone?: () => void; onCancel?: () => void; autoFocus?: boolean }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [start, setStart] = useState(nextMondayISO);
  const [hours, setHours] = useState('8');
  const [days, setDays] = useState<Set<number>>(() => new Set([1, 2, 3, 4, 5]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) nameRef.current?.focus(); }, []);

  const autoCode = codeFromName(name);
  const h = Number(hours);
  const valid = name.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(start) && h > 0 && h <= 24 && days.size > 0;

  const toggle = (d: number) => { const n = new Set(days); n.has(d) ? n.delete(d) : n.add(d); setDays(n); };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setErr(null);
    try {
      await newProject({ name: name.trim(), code: (code.trim() || autoCode).toUpperCase(), start, hoursPerDay: h, workDays: [...days].sort((a, b) => a - b) });
      onDone?.();
    } catch (ex) {
      setErr(ex instanceof ApiError && ex.status === 404
        ? 'This server cannot create projects yet (POST /api/new returned 404). Restart it once the update lands.'
        : ex instanceof Error ? ex.message : String(ex));
    } finally { setBusy(false); }
  };

  return (
    <form class="np" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape' && onCancel) { e.stopPropagation(); onCancel(); } }}>
      <label class="np-f wide">
        <span>Project name</span>
        <input ref={nameRef} required value={name} placeholder="e.g. Test Kitchen" onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <label class="np-f">
        <span>Code</span>
        <input class="mono" value={code} placeholder={autoCode || 'auto'} maxLength={20} onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <label class="np-f">
        <span>Start date</span>
        <input type="date" class="mono" required value={start} onInput={(e) => setStart((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <label class="np-f">
        <span>Hours per day</span>
        <input type="number" min={1} max={24} step={0.5} value={hours} onInput={(e) => setHours((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <div class="np-f wide">
        <span>Work days</span>
        <div class="np-days">
          {DAYS.map(([d, l]) => (
            <label key={d} class={`day ${days.has(d) ? 'on' : ''}`}>
              <input type="checkbox" checked={days.has(d)} onChange={() => toggle(d)} />{l}
            </label>
          ))}
        </div>
      </div>
      {err && <div class="np-err wide">{err}</div>}
      <div class="np-actions wide">
        {onCancel && <button type="button" class="tb ghost" onClick={onCancel}>Cancel</button>}
        <button type="submit" class="tb primary" disabled={!valid || busy}>{busy ? 'Creating…' : 'Create project'}</button>
      </div>
    </form>
  );
}

/** Shown in place of the grid when the server has no file open. */
export function Welcome() {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { api.files().then((r) => setFiles(r.files)).catch(() => setFiles([])); }, []);
  return (
    <div class="welcome">
      <div class="w-col">
        <div class="w-title">Start a new project</div>
        <div class="w-sub">A blank schedule with one calendar. Then describe the work to the agent and it builds the activities and logic.</div>
        <NewProjectForm />
      </div>
      <div class="w-col side">
        <div class="w-title">Or open a schedule</div>
        {files === null && <div class="w-sub">Loading…</div>}
        {files?.map((f) => (
          <button key={f.path} class="w-file" onClick={() => openFile(f.path)} title={f.path}>
            <span>{f.name}</span><span class="meta">{fmtBytes(f.size)}</span>
          </button>
        ))}
        <button class="link-btn" onClick={() => input.current?.click()}>Upload an .xer file…</button>
        <input ref={input} type="file" accept=".xer" style="display:none" onChange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) uploadFile(f).catch(fail); }} />
      </div>
    </div>
  );
}
