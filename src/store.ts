// One mutable app object + notify(), the Redhawk pattern: components call useApp()
// and re-render on every change. Patches replace single items in the arrays so the
// derived row list recomputes but nothing else is rebuilt.
import { useEffect, useReducer } from 'preact/hooks';
import type { CompactDiff, Patch, PatchOp, Snapshot, SnapTask } from '../lib/schedule/diff.ts';
import { api, ApiError, type History, type NewProject } from './api';
import { parseDate } from './util';

export type ChatEvent =
  | { kind: 'user'; turn: string; text: string }
  | { kind: 'status'; working: boolean }
  | { kind: 'text'; turn: string; delta: string }
  | { kind: 'tool_start'; turn: string; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; turn: string; id: string; name: string; ok: boolean; summary: string; diff?: CompactDiff; data?: unknown }
  | { kind: 'turn_end'; turn: string; ok: boolean; error?: string; cost_usd?: number; duration_ms?: number; num_turns?: number };

export interface UserMsg { kind: 'user'; turn: string; text: string }
export interface AssistantMsg { kind: 'assistant'; turn: string; text: string }
export interface ToolMsg { kind: 'tool'; turn: string; id: string; name: string; input: unknown; done: boolean; ok?: boolean; summary?: string; diff?: CompactDiff; data?: unknown; startedAt: number; endedAt?: number }
export interface EndMsg { kind: 'end'; turn: string; ok: boolean; error?: string; cost_usd?: number; duration_ms?: number; num_turns?: number }
export type Msg = UserMsg | AssistantMsg | ToolMsg | EndMsg;

/** 'edit': authored fields changed or the row is new (soft yellow, 2 s). 'move': only computed dates moved (0.6 s). */
export interface Highlight { at: number; kind: 'edit' | 'move' }
export const HL_MS = { edit: 2000, move: 600 } as const;

export interface App {
  snapshot: Snapshot | null;
  taskIndex: Map<number, number>;
  relIndex: Map<number, number>;
  wbsIndex: Map<number, number>;
  loadSeq: number;            // bumps when a whole snapshot arrives (refit the Gantt)
  noFile: boolean;            // server answered 404 for /api/snapshot
  offline: boolean;           // the server itself is unreachable
  online: boolean;            // websocket open
  selected: number | null;    // primary selection (details + arrows)
  selectedSet: Set<number>;   // every selected row
  scrollTo: { id: number; seq: number } | null;
  highlights: Map<number, Highlight>;   // task id -> when and how it was touched
  wbsHighlights: Map<number, number>;   // wbs id -> time it was added
  collapsed: Set<number>;     // wbs ids folded shut
  search: string;
  filesOpen: boolean;
  messages: Msg[];
  working: boolean;
  draft: string;
  finishFlash: 'earlier' | 'later' | null;
  history: History | null;   // null until the server answers /api/history
  error: string | null;
  chatWidth: number;
  detailsOpen: boolean;
  showLate: boolean;          // late-date bars in the Gantt
  focusSeq: number;           // bumps when the chat input should take focus
}

const saved = <T>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
const save = (key: string, v: unknown): void => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } };

export const app: App = {
  snapshot: null, taskIndex: new Map(), relIndex: new Map(), wbsIndex: new Map(), loadSeq: 0,
  noFile: false, offline: false, online: false,
  selected: null, selectedSet: new Set(), scrollTo: null, highlights: new Map(), wbsHighlights: new Map(), collapsed: new Set(), search: '',
  filesOpen: false, messages: [], working: false, draft: '', finishFlash: null, history: null, error: null,
  chatWidth: saved('sc.chatWidth', 380), detailsOpen: true, showLate: saved('sc.showLate', false), focusSeq: 0,
};

const listeners = new Set<() => void>();
export function notify(): void { for (const l of listeners) l(); }
export function useApp(): App {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { const fn = () => bump(undefined); listeners.add(fn); return () => { listeners.delete(fn); }; }, []);
  return app;
}

export function fail(err: unknown): void {
  app.error = err instanceof Error ? err.message : String(err);
  notify();
  setTimeout(() => { app.error = null; notify(); }, 6000);
}

// ---- snapshot + patches ------------------------------------------------------

function reindex(): void {
  const s = app.snapshot;
  app.taskIndex = new Map(); app.relIndex = new Map(); app.wbsIndex = new Map();
  if (!s) return;
  s.tasks.forEach((t, i) => app.taskIndex.set(t.id, i));
  s.rels.forEach((r, i) => app.relIndex.set(r.id, i));
  s.wbs.forEach((w, i) => app.wbsIndex.set(w.id, i));
}

export function setSnapshot(snap: Snapshot, fresh = false): void {
  const prev = app.snapshot;
  const sameFile = !fresh && prev?.file === snap.file;
  app.snapshot = snap;
  app.noFile = false; app.offline = false;
  reindex();
  if (!sameFile) { app.selected = null; app.selectedSet = new Set(); app.collapsed = new Set(); app.highlights = new Map(); app.wbsHighlights = new Map(); app.loadSeq++; }
  else if (prev) flashFinish(prev.project.finish, snap.project.finish);
  notify();
  refreshHistory();
}

export function setNoFile(): void { app.snapshot = null; app.noFile = true; app.offline = false; reindex(); notify(); }
export function setOffline(): void { app.offline = true; notify(); }

function flashFinish(from: string, to: string): void {
  if (from === to) return;
  const a = parseDate(from), b = parseDate(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;
  app.finishFlash = b < a ? 'earlier' : 'later';
  setTimeout(() => { app.finishFlash = null; notify(); }, 2200);
}

let clearTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleHighlightClear(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    const now = Date.now();
    for (const [id, h] of app.highlights) if (now - h.at >= HL_MS[h.kind]) app.highlights.delete(id);
    for (const [id, t] of app.wbsHighlights) if (now - t >= HL_MS.edit) app.wbsHighlights.delete(id);
    clearTimer = null;
    notify();
    if (app.highlights.size || app.wbsHighlights.size) scheduleHighlightClear();
  }, 650);
}

export function applyPatch(p: Patch): void {
  const s = app.snapshot;
  if (!s) return;
  const now = Date.now();
  const next: Snapshot = { ...s, seq: p.seq, changedSinceLoad: p.changedSinceLoad, warnings: p.warnings ?? s.warnings };
  let tasks = s.tasks, rels = s.rels, wbs = s.wbs;
  let tCopied = false, rCopied = false, wCopied = false;
  const prevFinish = s.project.finish;
  for (const op of p.ops) applyOp(op);
  function applyOp(op: PatchOp): void {
    switch (op.op) {
      case 'task': {
        if (!tCopied) { tasks = tasks.slice(); tCopied = true; }
        const i = app.taskIndex.get(op.task.id);
        const old = i === undefined ? undefined : tasks[i];
        if (i === undefined) { app.taskIndex.set(op.task.id, tasks.length); tasks.push(op.task); }
        else tasks[i] = op.task;
        const kind = !old || authoredChanged(old, op.task) ? 'edit' : 'move';
        const cur = app.highlights.get(op.task.id);
        // never downgrade a fresh edit highlight to a move flicker
        if (!(kind === 'move' && cur?.kind === 'edit' && now - cur.at < HL_MS.edit)) app.highlights.set(op.task.id, { at: now, kind });
        break;
      }
      case 'delete_task': {
        const i = app.taskIndex.get(op.id);
        if (i === undefined) break;
        if (!tCopied) { tasks = tasks.slice(); tCopied = true; }
        tasks.splice(i, 1);
        app.taskIndex.delete(op.id);
        for (let k = i; k < tasks.length; k++) app.taskIndex.set(tasks[k]!.id, k);
        app.highlights.delete(op.id);
        app.selectedSet.delete(op.id);
        if (app.selected === op.id) app.selected = null;
        break;
      }
      case 'rel': {
        if (!rCopied) { rels = rels.slice(); rCopied = true; }
        const i = app.relIndex.get(op.rel.id);
        if (i === undefined) { app.relIndex.set(op.rel.id, rels.length); rels.push(op.rel); }
        else rels[i] = op.rel;
        break;
      }
      case 'delete_rel': {
        const i = app.relIndex.get(op.id);
        if (i === undefined) break;
        if (!rCopied) { rels = rels.slice(); rCopied = true; }
        rels.splice(i, 1);
        app.relIndex.delete(op.id);
        for (let k = i; k < rels.length; k++) app.relIndex.set(rels[k]!.id, k);
        break;
      }
      case 'wbs': {
        if (!wCopied) { wbs = wbs.slice(); wCopied = true; }
        const i = app.wbsIndex.get(op.wbs.id);
        if (i === undefined) { app.wbsIndex.set(op.wbs.id, wbs.length); wbs.push(op.wbs); app.wbsHighlights.set(op.wbs.id, now); }
        else wbs[i] = op.wbs;
        break;
      }
      case 'delete_wbs': {
        const i = app.wbsIndex.get(op.id);
        if (i === undefined) break;
        if (!wCopied) { wbs = wbs.slice(); wCopied = true; }
        wbs.splice(i, 1);
        app.wbsIndex.delete(op.id);
        for (let k = i; k < wbs.length; k++) app.wbsIndex.set(wbs[k]!.id, k);
        break;
      }
      case 'project':
        next.project = op.project;
        break;
    }
  }
  next.tasks = tasks; next.rels = rels; next.wbs = wbs;
  app.snapshot = next;
  flashFinish(prevFinish, next.project.finish);
  scheduleHighlightClear();
  notify();
  refreshHistory();
}

const AUTHORED: (keyof SnapTask)[] = ['code', 'name', 'wbs', 'type', 'status', 'dur', 'remain', 'pct', 'cal', 'cstr', 'cstrDate', 'as', 'ae'];
function authoredChanged(a: SnapTask, b: SnapTask): boolean { return AUTHORED.some((k) => a[k] !== b[k]); }

let histTimer: ReturnType<typeof setTimeout> | null = null;
export function refreshHistory(): void {
  if (histTimer) clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    histTimer = null;
    api.history().then((h) => { app.history = h; notify(); }).catch(() => { /* older server, buttons stay enabled */ });
  }, 150);
}

// ---- selection / view --------------------------------------------------------

export function select(id: number | null, opts: { scroll?: boolean; add?: boolean } = {}): void {
  if (id === null) { app.selected = null; app.selectedSet = new Set(); notify(); return; }
  if (opts.add) { const set = new Set(app.selectedSet); set.has(id) ? set.delete(id) : set.add(id); app.selectedSet = set; app.selected = set.has(id) ? id : app.selected; }
  else { app.selected = id; app.selectedSet = new Set([id]); }
  if (opts.scroll) revealTask(id);
  notify();
}

export function selectMany(ids: number[]): void {
  if (!ids.length) return;
  app.selectedSet = new Set(ids);
  app.selected = ids[0]!;
  revealTask(ids[0]!);
  notify();
}

/** Expand the WBS chain above a task and ask the grid to scroll it into view. */
export function revealTask(id: number): void {
  const s = app.snapshot; if (!s) return;
  const i = app.taskIndex.get(id); if (i === undefined) return;
  let w: number | null = s.tasks[i]!.wbs;
  let changed = false;
  while (w !== null) {
    if (app.collapsed.has(w)) { app.collapsed.delete(w); changed = true; }
    const wi = app.wbsIndex.get(w);
    w = wi === undefined ? null : s.wbs[wi]!.parent;
  }
  if (changed) app.collapsed = new Set(app.collapsed);
  app.scrollTo = { id, seq: (app.scrollTo?.seq ?? 0) + 1 };
}

export function selectByCodes(codes: string[]): void {
  const s = app.snapshot; if (!s) return;
  const want = new Set(codes.map((c) => c.toUpperCase()));
  const ids = s.tasks.filter((t) => want.has(t.code.toUpperCase())).map((t) => t.id);
  if (ids.length) selectMany(ids);
}

export function toggleWbs(id: number): void {
  const set = new Set(app.collapsed);
  set.has(id) ? set.delete(id) : set.add(id);
  app.collapsed = set; notify();
}
export function setAllCollapsed(collapsed: boolean): void {
  const s = app.snapshot; if (!s) return;
  app.collapsed = collapsed ? new Set(s.wbs.filter((w) => w.parent !== null && app.wbsIndex.has(w.parent)).map((w) => w.id)) : new Set();
  notify();
}
export function setSearch(q: string): void { app.search = q; notify(); }
export function setFilesOpen(v: boolean): void { app.filesOpen = v; notify(); }
export function setDetailsOpen(v: boolean): void { app.detailsOpen = v; notify(); }
export function setChatWidth(w: number): void { app.chatWidth = Math.max(280, Math.min(720, Math.round(w))); save('sc.chatWidth', app.chatWidth); notify(); }
export function setShowLate(v: boolean): void { app.showLate = v; save('sc.showLate', v); notify(); }
/** Put text in the chat input (without sending) and focus it. */
export function prefillChat(text: string): void { app.draft = text; app.focusSeq++; notify(); }
export function setOnline(v: boolean): void { if (app.online !== v) { app.online = v; notify(); } }

// ---- chat ---------------------------------------------------------------------

export function chatEvent(ev: ChatEvent): void {
  const m = app.messages;
  switch (ev.kind) {
    case 'user': m.push({ kind: 'user', turn: ev.turn, text: ev.text }); break;
    case 'status': app.working = ev.working; break;
    case 'text': {
      const last = m[m.length - 1];
      if (last && last.kind === 'assistant' && last.turn === ev.turn) last.text += ev.delta;
      else m.push({ kind: 'assistant', turn: ev.turn, text: ev.delta });
      break;
    }
    case 'tool_start': {
      // Sent twice per call (input null, then the full input): upsert by id.
      const card = m.find((x): x is ToolMsg => x.kind === 'tool' && x.id === ev.id);
      if (card) { if (ev.input !== null && ev.input !== undefined) card.input = ev.input; }
      else m.push({ kind: 'tool', turn: ev.turn, id: ev.id, name: ev.name, input: ev.input, done: false, startedAt: Date.now() });
      break;
    }
    case 'tool_result': {
      let card = m.find((x): x is ToolMsg => x.kind === 'tool' && x.id === ev.id);
      if (!card) { card = { kind: 'tool', turn: ev.turn, id: ev.id, name: ev.name, input: undefined, done: false, startedAt: Date.now() }; m.push(card); }
      card.done = true; card.ok = ev.ok; card.summary = ev.summary; card.diff = ev.diff; card.data = ev.data; card.endedAt = Date.now();
      break;
    }
    case 'turn_end': m.push({ kind: 'end', turn: ev.turn, ok: ev.ok, error: ev.error, cost_usd: ev.cost_usd, duration_ms: ev.duration_ms, num_turns: ev.num_turns }); break;
  }
  app.messages = m.slice();   // new reference so memoised lists see the change
  notify();
}

/** The server replays the recent chat events on every (re)connect: start from empty. */
export function resetChat(): void { app.messages = []; app.working = false; notify(); }

export function setDraft(text: string): void { app.draft = text; notify(); }

export let sendWs: (msg: { type: 'chat'; text: string } | { type: 'interrupt' }) => boolean = () => false;
export function setSender(fn: typeof sendWs): void { sendWs = fn; }

export function sendChat(text: string): void {
  const t = text.trim();
  if (!t) return;
  app.draft = '';
  notify();
  if (!sendWs({ type: 'chat', text: t })) api.chat(t).catch(fail);
}
export function interrupt(): void {
  if (!sendWs({ type: 'interrupt' })) api.interrupt().catch(fail);
}

// ---- file + edit commands -----------------------------------------------------

export async function loadSnapshot(): Promise<void> {
  try { setSnapshot(await api.snapshot()); }
  catch (err) {
    if (err instanceof ApiError && err.status === 404) setNoFile();
    else setOffline();
  }
}
export async function openFile(path: string): Promise<void> { try { setSnapshot(await api.open(path)); } catch (err) { fail(err); } }
/** POST /api/new. Throws so the form can show the error inline. */
export async function newProject(p: NewProject): Promise<void> {
  setSnapshot(await api.newProject(p), true);
}
export async function uploadFile(file: File): Promise<void> { try { setSnapshot(await api.upload(file.name, file)); } catch (err) { fail(err); } }
export async function undo(): Promise<void> { try { await api.undo(); } catch (err) { fail(err); } }
export async function redo(): Promise<void> { try { await api.redo(); } catch (err) { fail(err); } }
