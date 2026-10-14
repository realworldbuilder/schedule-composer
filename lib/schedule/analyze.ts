import type { Schedule, TaskView } from './model.ts';
import type { CpmResult } from './cpm.ts';
import { fmtP6Date, parseP6Date } from './dates.ts';

export interface Filter {
  q?: string; wbs?: number | string; status?: 'NotStart' | 'Active' | 'Complete'; type?: 'Task' | 'Mile' | 'FinMile' | 'LOE';
  critical?: boolean; float_lte?: number; start_after?: string; finish_before?: string; codes?: string[]; constrained?: boolean;
}

export interface Row { id: number; code: string; name: string; wbs: string; type: string; status: string; dur_h: number; remain_h: number; es: string; ef: string; tf: number | null; cstr: string; driving: boolean; preds: number; succs: number }

export function rowOf(s: Schedule, cpm: CpmResult, t: TaskView): Row {
  const n = cpm.nodes.get(t.task_id);
  return {
    id: t.task_id, code: t.task_code, name: t.task_name, wbs: s.wbsById(t.wbs_id)?.wbs_short_name ?? String(t.wbs_id),
    type: t.task_type.slice(3), status: t.status_code.slice(3), dur_h: t.target_drtn_hr_cnt, remain_h: t.remain_drtn_hr_cnt,
    es: fmtP6Date(n?.es ?? t.start), ef: fmtP6Date(n?.ef ?? t.finish), tf: n?.tf ?? t.total_float_hr_cnt,
    cstr: t.cstr_type ? `${t.cstr_type.slice(3)} ${fmtP6Date(t.cstr_date)}` : '', driving: n?.onLongestPath ?? false,
    preds: s.predsOf(t.task_id).length, succs: s.succsOf(t.task_id).length,
  };
}

export function resolveWbs(s: Schedule, w: number | string): number | null {
  if (typeof w === 'number') return s.wbsById(w) ? w : null;
  if (/^\d+$/.test(w) && s.wbsById(+w)) return +w;
  const byShort = s.wbsByShortName(w);
  if (byShort) return byShort.wbs_id;
  // path like ROOT.A.B or a name fragment
  const last = w.split('.').at(-1)!;
  const hit = s.wbs().find((x) => x.wbs_short_name.toLowerCase() === last.toLowerCase()) ?? s.wbs().find((x) => x.wbs_name.toLowerCase().includes(w.toLowerCase()));
  return hit ? hit.wbs_id : null;
}

export function filterTasks(s: Schedule, cpm: CpmResult, f: Filter): TaskView[] {
  const projId = s.project.proj_id;
  let tasks = s.tasks().filter((t) => t.proj_id === projId);
  if (f.codes?.length) {
    const want = new Set(f.codes.map((c) => c.toLowerCase()));
    tasks = tasks.filter((t) => want.has(t.task_code.toLowerCase()));
  }
  if (f.wbs !== undefined) {
    const id = resolveWbs(s, f.wbs);
    if (id === null) throw new Error(`WBS "${f.wbs}" not found`);
    const set = new Set(s.wbsDescendants(id));
    tasks = tasks.filter((t) => set.has(t.wbs_id));
  }
  if (f.status) tasks = tasks.filter((t) => t.status_code === `TK_${f.status}`);
  if (f.type) tasks = tasks.filter((t) => t.task_type === `TT_${f.type}`);
  if (f.critical !== undefined) tasks = tasks.filter((t) => (cpm.nodes.get(t.task_id)?.critical ?? false) === f.critical);
  if (f.float_lte !== undefined) tasks = tasks.filter((t) => { const tf = cpm.nodes.get(t.task_id)?.tf; return tf !== null && tf !== undefined && tf <= f.float_lte!; });
  if (f.constrained !== undefined) tasks = tasks.filter((t) => (t.cstr_type !== '') === f.constrained);
  if (f.start_after) { const d = parseP6Date(f.start_after); if (d !== null) tasks = tasks.filter((t) => (cpm.nodes.get(t.task_id)?.es ?? t.start ?? 0) >= d); }
  if (f.finish_before) { const d = parseP6Date(f.finish_before); if (d !== null) tasks = tasks.filter((t) => (cpm.nodes.get(t.task_id)?.ef ?? t.finish ?? Infinity) <= d); }
  if (f.q) {
    const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    tasks = tasks.filter((t) => { const hay = `${t.task_code} ${t.task_name} ${s.wbsById(t.wbs_id)?.wbs_name ?? ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  }
  return tasks;
}

export function sortTasks(_s: Schedule, cpm: CpmResult, tasks: TaskView[], sort: 'es' | 'tf' | 'code' | 'ef' = 'es'): TaskView[] {
  const key = (t: TaskView): number | string => {
    const n = cpm.nodes.get(t.task_id);
    if (sort === 'code') return t.task_code;
    if (sort === 'tf') return n?.tf ?? Infinity;
    if (sort === 'ef') return n?.ef ?? t.finish ?? Infinity;
    return n?.es ?? t.start ?? Infinity;
  };
  return [...tasks].sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : a.task_code.localeCompare(b.task_code); });
}

export function summary(s: Schedule, cpm: CpmResult) {
  const p = s.project;
  const tasks = s.tasks().filter((t) => t.proj_id === p.proj_id);
  const byStatus: Record<string, number> = {}; const byType: Record<string, number> = {};
  for (const t of tasks) { byStatus[t.status_code.slice(3)] = (byStatus[t.status_code.slice(3)] ?? 0) + 1; byType[t.task_type.slice(3)] = (byType[t.task_type.slice(3)] ?? 0) + 1; }
  const logic = checkLogic(s, cpm, 5);
  const wbsTree = s.wbs().filter((w) => w.proj_id === p.proj_id).sort((a, b) => a.seq_num - b.seq_num).map((w) => ({ id: w.wbs_id, parent: w.parent_wbs_id, code: w.wbs_short_name, name: w.wbs_name, path: s.wbsPath(w.wbs_id), tasks: tasks.filter((t) => t.wbs_id === w.wbs_id).length }));
  return {
    project: { id: p.proj_id, name: p.s('proj_short_name'), data_date: fmtP6Date(cpm.dataDate), finish: fmtP6Date(cpm.finish), plan_start: fmtP6Date(p.plan_start_date), plan_end: fmtP6Date(p.plan_end_date), float_type: s.schedOptions.floatType, lag_calendar: s.schedOptions.lagCalendar, critical_threshold_h: p.critical_drtn_hr_cnt },
    counts: { activities: tasks.length, relationships: s.rels().length, by_status: byStatus, by_type: byType, critical: tasks.filter((t) => cpm.nodes.get(t.task_id)?.critical).length, negative_float: logic.negative_float.count, open_starts: logic.open_starts.count, open_ends: logic.open_ends.count, constrained: logic.constraints.count },
    calendars: s.calendarRows().map((c) => ({ id: c.clndr_id, name: c.clndr_name, day_hr: c.day_hr_cnt, activities: tasks.filter((t) => t.clndr_id === c.clndr_id).length })),
    wbs: wbsTree,
    longest_path: cpm.longestPath.slice(0, 30).map((id) => { const t = s.task(id)!; const n = cpm.nodes.get(id)!; return `${t.task_code} ${t.task_name} (${fmtP6Date(n.es).slice(0, 10)} -> ${fmtP6Date(n.ef).slice(0, 10)})`; }),
    warnings: cpm.warnings,
    units: 'All durations, lags and floats are HOURS. Dates are YYYY-MM-DD HH:MM.',
  };
}

export function checkLogic(s: Schedule, cpm: CpmResult, limit = 50) {
  const p = s.project;
  const tasks = s.tasks().filter((t) => t.proj_id === p.proj_id && t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE');
  const open = (t: TaskView) => t.status_code !== 'TK_Complete';
  const lbl = (t: TaskView) => `${t.task_code} ${t.task_name}`;
  const openStarts = tasks.filter((t) => open(t) && t.status_code === 'TK_NotStart' && s.predsOf(t.task_id).length === 0 && t.task_type !== 'TT_Mile');
  const openEnds = tasks.filter((t) => open(t) && s.succsOf(t.task_id).length === 0 && t.task_type !== 'TT_FinMile');
  const neg = tasks.filter((t) => { const tf = cpm.nodes.get(t.task_id)?.tf; return tf !== null && tf !== undefined && tf < 0; }).sort((a, b) => (cpm.nodes.get(a.task_id)!.tf!) - (cpm.nodes.get(b.task_id)!.tf!));
  const dangling = tasks.filter((t) => open(t) && s.succsOf(t.task_id).length > 0 && s.succsOf(t.task_id).every((r) => r.pred_type === 'PR_SS') && t.task_type === 'TT_Task');
  const negLags = s.rels().filter((r) => r.lag_hr_cnt < 0);
  const bigLags = s.rels().filter((r) => r.lag_hr_cnt > 80);
  const constrained = tasks.filter((t) => t.cstr_type !== '');
  const hard = constrained.filter((t) => /MSO$|MEO$|MAND/.test(t.cstr_type));
  const relStr = (r: { pred_task_id: number; task_id: number; short: string; lag_hr_cnt: number }) => `${s.task(r.pred_task_id)?.task_code} -> ${s.task(r.task_id)?.task_code} ${r.short}${r.lag_hr_cnt ? (r.lag_hr_cnt > 0 ? '+' : '') + r.lag_hr_cnt + 'h' : ''}`;
  const pack = <T>(arr: T[], f: (x: T) => string) => ({ count: arr.length, sample: arr.slice(0, limit).map(f) });
  return {
    open_starts: pack(openStarts, lbl),
    open_ends: pack(openEnds, lbl),
    negative_float: pack(neg, (t) => `${lbl(t)} TF ${cpm.nodes.get(t.task_id)!.tf}h`),
    dangling_ss: pack(dangling, lbl),
    negative_lags: pack(negLags, relStr),
    long_lags: pack(bigLags, relStr),
    constraints: pack(constrained, (t) => `${lbl(t)} ${t.cstr_type.slice(3)} ${fmtP6Date(t.cstr_date)}`),
    hard_constraints: pack(hard, lbl),
    warnings: cpm.warnings,
  };
}
