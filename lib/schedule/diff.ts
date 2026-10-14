// Wire shapes shared by the server, the agent tools and the browser.
import { fmtP6Date, parseP6Date } from './dates.ts';
import { workHoursBetween } from './calendar.ts';
import type { CpmResult } from './cpm.ts';
import type { FieldChange, Schedule } from './model.ts';

export type SnapType = 'Task' | 'Mile' | 'FinMile' | 'LOE' | 'WBS' | 'Rsrc';
export type SnapStatus = 'NotStart' | 'Active' | 'Complete';

export interface SnapTask {
  id: number; code: string; name: string; wbs: number; type: SnapType; status: SnapStatus;
  dur: number; remain: number; pct: number; cal: number;
  es: string; ef: string; ls: string; lf: string; as: string; ae: string;
  tf: number | null; ff: number | null; cstr: string; cstrDate: string;
  critical: boolean; driving: boolean;
}
export interface SnapRel { id: number; pred: number; succ: number; type: 'FS' | 'SS' | 'FF' | 'SF'; lag: number; driving: boolean }
export interface SnapWbs { id: number; parent: number | null; code: string; name: string; seq: number; root: boolean }
export interface SnapProject { id: number; name: string; code: string; dataDate: string; finish: string; planStart: string; planEnd: string }
export interface Snapshot {
  file: string; seq: number;
  project: SnapProject;
  calendars: { id: number; name: string; dayHours: number }[];
  tasks: SnapTask[]; rels: SnapRel[]; wbs: SnapWbs[];
  warnings: string[];
  changedSinceLoad: number;
}

export type PatchOp =
  | { op: 'task'; task: SnapTask }
  | { op: 'delete_task'; id: number }
  | { op: 'rel'; rel: SnapRel }
  | { op: 'delete_rel'; id: number }
  | { op: 'wbs'; wbs: SnapWbs }
  | { op: 'delete_wbs'; id: number }
  | { op: 'project'; project: SnapProject };

export interface Patch { seq: number; turn: string; label: string; ops: PatchOp[]; changedSinceLoad: number; warnings: string[] }

export interface CompactDiff {
  label: string;
  added: string[];
  deleted: string[];
  updated: { code: string; field: string; from: string; to: string }[];
  updatedCount: number;
  relationships: { added: string[]; deleted: string[]; updated: string[] };
  cpm: { finish: { from: string; to: string }; moved: number; critical: number; negativeFloat: number; finishDeltaHours: number; finishDeltaDays: number };
  warnings: string[];
}

const typeMap: Record<string, SnapType> = { TT_Task: 'Task', TT_Mile: 'Mile', TT_FinMile: 'FinMile', TT_LOE: 'LOE', TT_WBS: 'WBS', TT_Rsrc: 'Rsrc' };
const statusMap: Record<string, SnapStatus> = { TK_NotStart: 'NotStart', TK_Active: 'Active', TK_Complete: 'Complete' };

export function snapshotOf(s: Schedule, cpm: CpmResult | null, file: string, seq: number, changedSinceLoad: number): Snapshot {
  const p = s.project;
  const tasks: SnapTask[] = s.tasks().filter((t) => t.proj_id === p.proj_id).map((t) => {
    const n = cpm?.nodes.get(t.task_id);
    return {
      id: t.task_id, code: t.task_code, name: t.task_name, wbs: t.wbs_id, type: typeMap[t.task_type] ?? 'Task', status: statusMap[t.status_code] ?? 'NotStart',
      dur: t.target_drtn_hr_cnt, remain: t.remain_drtn_hr_cnt, pct: t.phys_complete_pct, cal: t.clndr_id,
      es: n ? fmtP6Date(n.es) : fmtP6Date(t.early_start_date), ef: n ? fmtP6Date(n.ef) : fmtP6Date(t.early_end_date),
      ls: n ? fmtP6Date(n.ls) : fmtP6Date(t.late_start_date), lf: n ? fmtP6Date(n.lf) : fmtP6Date(t.late_end_date),
      as: fmtP6Date(t.act_start_date), ae: fmtP6Date(t.act_end_date),
      tf: n ? n.tf : t.total_float_hr_cnt, ff: n ? n.ff : t.free_float_hr_cnt,
      cstr: t.cstr_type ? t.cstr_type.slice(3) : '', cstrDate: fmtP6Date(t.cstr_date),
      critical: n ? n.critical : false, driving: n ? n.onLongestPath : t.driving_path_flag,
    };
  });
  const rels: SnapRel[] = s.rels().map((r) => ({ id: r.task_pred_id, pred: r.pred_task_id, succ: r.task_id, type: r.short as SnapRel['type'], lag: r.lag_hr_cnt, driving: cpm ? cpm.driving.has(r.task_pred_id) : false }));
  const wbs: SnapWbs[] = s.wbs().filter((w) => w.proj_id === p.proj_id).map((w) => ({ id: w.wbs_id, parent: w.parent_wbs_id, code: w.wbs_short_name, name: w.wbs_name, seq: w.seq_num, root: w.proj_node_flag }));
  return {
    file, seq,
    project: projectOf(s, cpm),
    calendars: s.calendarRows().map((c) => ({ id: c.clndr_id, name: c.clndr_name, dayHours: c.day_hr_cnt || 8 })),
    tasks, rels, wbs, warnings: cpm?.warnings ?? [], changedSinceLoad,
  };
}

export function projectOf(s: Schedule, cpm: CpmResult | null): SnapProject {
  const p = s.project;
  return { id: p.proj_id, name: p.s('proj_short_name'), code: p.s('proj_short_name'), dataDate: fmtP6Date(cpm?.dataDate ?? s.dataDate), finish: fmtP6Date(cpm?.finish ?? p.scd_end_date), planStart: fmtP6Date(p.plan_start_date), planEnd: fmtP6Date(p.plan_end_date) };
}

/** Ops that turn snapshot a into snapshot b. */
export function diffSnapshots(a: Snapshot, b: Snapshot): PatchOp[] {
  const ops: PatchOp[] = [];
  const at = new Map(a.tasks.map((t) => [t.id, JSON.stringify(t)]));
  for (const t of b.tasks) { const j = JSON.stringify(t); if (at.get(t.id) !== j) ops.push({ op: 'task', task: t }); at.delete(t.id); }
  for (const id of at.keys()) ops.push({ op: 'delete_task', id });
  const ar = new Map(a.rels.map((r) => [r.id, JSON.stringify(r)]));
  for (const r of b.rels) { const j = JSON.stringify(r); if (ar.get(r.id) !== j) ops.push({ op: 'rel', rel: r }); ar.delete(r.id); }
  for (const id of ar.keys()) ops.push({ op: 'delete_rel', id });
  const aw = new Map(a.wbs.map((w) => [w.id, JSON.stringify(w)]));
  for (const w of b.wbs) { const j = JSON.stringify(w); if (aw.get(w.id) !== j) ops.push({ op: 'wbs', wbs: w }); aw.delete(w.id); }
  for (const id of aw.keys()) ops.push({ op: 'delete_wbs', id });
  if (JSON.stringify(a.project) !== JSON.stringify(b.project)) ops.push({ op: 'project', project: b.project });
  return ops;
}

const AUTHORED = new Set(['task_name', 'task_code', 'wbs_id', 'clndr_id', 'task_type', 'target_drtn_hr_cnt', 'remain_drtn_hr_cnt', 'cstr_type', 'cstr_date', 'status_code', 'act_start_date', 'act_end_date', 'pred_type', 'lag_hr_cnt', 'last_recalc_date']);

export function compactDiff(label: string, before: Snapshot, after: Snapshot, changes: FieldChange[], s: Schedule, warnings: string[]): CompactDiff {
  const bt = new Map(before.tasks.map((t) => [t.id, t]));
  const atm = new Map(after.tasks.map((t) => [t.id, t]));
  const added = after.tasks.filter((t) => !bt.has(t.id)).map((t) => `${t.code} ${t.name}`);
  const deleted = before.tasks.filter((t) => !atm.has(t.id)).map((t) => `${t.code} ${t.name}`);
  const codeOf = (c: FieldChange) => (c.table === 'TASK' ? (atm.get(c.id)?.code ?? bt.get(c.id)?.code ?? String(c.id)) : c.table === 'TASKPRED' ? relLabel(s, c.id, before) : c.table);
  const authored = changes.filter((c) => AUTHORED.has(c.field) && c.table !== 'PROJECT');
  const updated = authored.slice(0, 40).map((c) => ({ code: codeOf(c), field: c.field, from: c.from, to: c.to }));
  const br = new Map(before.rels.map((r) => [r.id, r]));
  const ar = new Map(after.rels.map((r) => [r.id, r]));
  const relStr = (r: SnapRel, snap: Snapshot) => { const m = new Map(snap.tasks.map((t) => [t.id, t.code])); return `${m.get(r.pred) ?? r.pred} -> ${m.get(r.succ) ?? r.succ} ${r.type}${r.lag ? (r.lag > 0 ? '+' : '') + r.lag + 'h' : ''}`; };
  const relationships = {
    added: after.rels.filter((r) => !br.has(r.id)).map((r) => relStr(r, after)),
    deleted: before.rels.filter((r) => !ar.has(r.id)).map((r) => relStr(r, before)),
    updated: after.rels.filter((r) => br.has(r.id) && (br.get(r.id)!.type !== r.type || br.get(r.id)!.lag !== r.lag)).map((r) => `${relStr(br.get(r.id)!, before)} => ${r.type}${r.lag ? (r.lag > 0 ? '+' : '') + r.lag + 'h' : ''}`),
  };
  let moved = 0;
  for (const t of after.tasks) { const o = bt.get(t.id); if (o && (o.es !== t.es || o.ef !== t.ef)) moved++; }
  const critical = after.tasks.filter((t) => t.critical && t.status !== 'Complete').length;
  const negativeFloat = after.tasks.filter((t) => t.tf !== null && t.tf < 0).length;
  const fromMs = parseP6Date(before.project.finish); const toMs = parseP6Date(after.project.finish);
  const cal = s.calendar(s.project.clndr_id);
  const finishDeltaHours = fromMs !== null && toMs !== null ? Math.round(workHoursBetween(cal, fromMs, toMs)) : 0;
  const finishDeltaDays = Math.round((finishDeltaHours / cal.dayHours) * 10) / 10;
  return { label, added, deleted, updated, updatedCount: authored.length, relationships, cpm: { finish: { from: before.project.finish, to: after.project.finish }, moved, critical, negativeFloat, finishDeltaHours, finishDeltaDays }, warnings };
}

function relLabel(s: Schedule, id: number, before: Snapshot): string {
  const r = s.rel(id);
  const m = new Map(before.tasks.map((t) => [t.id, t.code]));
  if (!r) { const o = before.rels.find((x) => x.id === id); return o ? `${m.get(o.pred)} -> ${m.get(o.succ)}` : `rel ${id}`; }
  return `${m.get(r.pred_task_id) ?? s.task(r.pred_task_id)?.task_code} -> ${m.get(r.task_id) ?? s.task(r.task_id)?.task_code}`;
}
