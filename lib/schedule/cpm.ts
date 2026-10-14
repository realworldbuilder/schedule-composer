import { addWorkHours, nextWorkStart, prevWorkEnd, workHoursBetween, CAL_24H, type WorkCal } from './calendar.ts';
import { fmtP6Date, type Ms } from './dates.ts';
import type { FieldChange, RelView, Schedule, TaskView } from './model.ts';

export class CpmCycleError extends Error {
  readonly loop: string[];
  constructor(loop: string[]) {
    super(`Logic loop: ${loop.join(' -> ')}`);
    this.name = 'CpmCycleError';
    this.loop = loop;
  }
}

export interface CpmNode {
  id: number;
  code: string;
  status: 'TK_NotStart' | 'TK_Active' | 'TK_Complete';
  es: Ms; ef: Ms; ls: Ms; lf: Ms;
  /** Remaining-work dates for active tasks (equal to es/ef/ls/lf otherwise). */
  rs: Ms; re: Ms; rls: Ms; rlf: Ms;
  tf: number | null; ff: number | null;
  critical: boolean;
  /** Completed: dates are facts and never move. */
  frozen: boolean;
  /** Driving predecessor relationship ids (the ones that set this node's dates). */
  drivers: number[];
  onLongestPath: boolean;
}

export interface CpmResult {
  dataDate: Ms;
  finish: Ms;
  nodes: Map<number, CpmNode>;
  driving: Set<number>;
  longestPath: number[];
  warnings: string[];
  ms: number;
}

interface Edge { rel: RelView; pred: number; succ: number; type: string; lag: number; lagCal: WorkCal }

const EPS = 60_000; // one minute

export function runCpm(s: Schedule, opts: { dataDate?: Ms } = {}): CpmResult {
  const t0 = performance.now();
  const warnings: string[] = [];
  const dataDate = opts.dataDate ?? s.dataDate;
  const so = s.schedOptions;
  const projId = s.project.proj_id;
  const projCal = s.calendar(s.project.clndr_id);

  // ---- nodes
  type W = { t: TaskView; cal: WorkCal; dur: number; kind: 'task' | 'start-ms' | 'finish-ms' };
  const work = new Map<number, W>();
  let loeSkipped = 0; let wbsSkipped = 0;
  for (const t of s.tasks()) {
    if (t.proj_id !== projId) continue;
    const type = t.task_type;
    if (type === 'TT_LOE') { loeSkipped++; continue; }
    if (type === 'TT_WBS') { wbsSkipped++; continue; }
    const cal = s.calendarFor(t);
    const kind = type === 'TT_Mile' ? 'start-ms' : type === 'TT_FinMile' ? 'finish-ms' : 'task';
    const dur = kind === 'task' ? (t.status_code === 'TK_NotStart' ? t.target_drtn_hr_cnt : t.remain_drtn_hr_cnt) : 0;
    work.set(t.task_id, { t, cal, dur, kind });
  }
  if (loeSkipped) warnings.push(`${loeSkipped} level-of-effort activities left as stored (not scheduled in v1)`);
  if (wbsSkipped) warnings.push(`${wbsSkipped} WBS summary activities left as stored`);

  // ---- edges
  const predsOf = new Map<number, Edge[]>(); const succsOf = new Map<number, Edge[]>();
  let external = 0;
  for (const rel of s.rels()) {
    const p = work.get(rel.pred_task_id); const c = work.get(rel.task_id);
    if (!p || !c) { external++; continue; }
    const lagCal = so.lagCalendar === 'succ' ? c.cal : so.lagCalendar === '24h' ? CAL_24H : so.lagCalendar === 'project' ? projCal : p.cal;
    const e: Edge = { rel, pred: rel.pred_task_id, succ: rel.task_id, type: rel.pred_type, lag: rel.lag_hr_cnt, lagCal };
    (predsOf.get(e.succ) ?? predsOf.set(e.succ, []).get(e.succ)!).push(e);
    (succsOf.get(e.pred) ?? succsOf.set(e.pred, []).get(e.pred)!).push(e);
  }
  if (external) warnings.push(`${external} relationships to activities outside this project or to LOE/WBS activities were ignored`);

  // ---- topological order (Kahn)
  const indeg = new Map<number, number>();
  for (const id of work.keys()) indeg.set(id, predsOf.get(id)?.length ?? 0);
  const queue: number[] = []; for (const [id, d] of indeg) if (d === 0) queue.push(id);
  const order: number[] = [];
  while (queue.length) {
    const id = queue.shift()!; order.push(id);
    for (const e of succsOf.get(id) ?? []) { const d = indeg.get(e.succ)! - 1; indeg.set(e.succ, d); if (d === 0) queue.push(e.succ); }
  }
  if (order.length !== work.size) {
    const left = new Set([...indeg].filter(([, d]) => d > 0).map(([id]) => id));
    throw new CpmCycleError(findLoop(left, succsOf).map((id) => work.get(id)!.t.task_code));
  }

  // ---- forward pass
  const nodes = new Map<number, CpmNode>();
  const driving = new Set<number>();
  const ddStart = (cal: WorkCal) => nextWorkStart(cal, dataDate);
  for (const id of order) {
    const w = work.get(id)!; const t = w.t; const cal = w.cal;
    const n: CpmNode = { id, code: t.task_code, status: t.status_code, es: 0, ef: 0, ls: 0, lf: 0, rs: 0, re: 0, rls: 0, rlf: 0, tf: null, ff: null, critical: false, frozen: false, drivers: [], onLongestPath: false };
    nodes.set(id, n);
    const preds = predsOf.get(id) ?? [];
    const S: { v: Ms; e?: Edge }[] = []; const F: { v: Ms; e?: Edge }[] = [];
    for (const e of preds) {
      const p = nodes.get(e.pred)!;
      // Successor logic drives the remaining portion of the predecessor; for active preds use re.
      const pStart = p.status === 'TK_Active' ? p.es : p.es; const pFinish = p.ef;
      if (e.type === 'PR_FS') S.push({ v: addWorkHours(e.lagCal, pFinish, e.lag), e });
      else if (e.type === 'PR_SS') S.push({ v: addWorkHours(e.lagCal, pStart, e.lag), e });
      else if (e.type === 'PR_FF') F.push({ v: addWorkHours(e.lagCal, pFinish, e.lag), e });
      else if (e.type === 'PR_SF') F.push({ v: addWorkHours(e.lagCal, pStart, e.lag), e });
    }
    const cstr = t.cstr_type; const cd = t.cstr_date;
    if (cd !== null) {
      if (cstr === 'CS_MSOA') S.push({ v: cd });
      else if (cstr === 'CS_MEOA') F.push({ v: cd });
    }

    if (t.status_code === 'TK_Complete') {
      const as = t.act_start_date ?? t.early_start_date ?? dataDate; const ae = t.act_end_date ?? as;
      Object.assign(n, { es: as, ef: ae, ls: as, lf: ae, rs: ae, re: ae, rls: ae, rlf: ae, frozen: true });
      continue;
    }

    const isActive = t.status_code === 'TK_Active' && t.act_start_date !== null;
    const dur = w.dur;
    // Remaining work cannot start before the data date; with retained logic it also waits for predecessors.
    let startCands = [...S]; let finishCands = [...F];
    if (isActive && !so.retainedLogic) { startCands = []; finishCands = []; }
    let rs = ddStart(cal);
    let via: Edge | undefined;
    for (const c of startCands) { const v = nextWorkStart(cal, c.v); if (v > rs + EPS / 2) { rs = v; via = c.e; } else if (Math.abs(v - rs) <= EPS && c.e && !via) via = c.e; }
    const startDrivers = startCands.filter((c) => c.e && Math.abs(nextWorkStart(cal, c.v) - rs) <= EPS).map((c) => c.e!);
    let re: Ms;
    let finishDrivers: Edge[] = [];
    if (w.kind === 'finish-ms') {
      const all = [...startCands, ...finishCands];
      let best: Ms | null = null;
      for (const c of all) if (best === null || c.v > best + EPS / 2) best = c.v;
      if (best === null) best = rs; // no logic: sits at the data date (snapped)
      re = best; rs = best;
      finishDrivers = all.filter((c) => c.e && Math.abs(c.v - best) <= EPS).map((c) => c.e!);
    } else {
      re = dur > 0 ? addWorkHours(cal, rs, dur) : rs;
      let fmax: Ms | null = null;
      for (const c of finishCands) if (fmax === null || c.v > fmax) fmax = c.v;
      if (fmax !== null && fmax > re + EPS / 2) {
        re = dur > 0 ? prevWorkEnd(cal, fmax) : nextWorkStart(cal, fmax);
        if (re < fmax - EPS) re = fmax; // never earlier than the constraint itself
        rs = dur > 0 ? addWorkHours(cal, re, -dur) : re;
        finishDrivers = finishCands.filter((c) => c.e && Math.abs(c.v - fmax!) <= EPS).map((c) => c.e!);
      }
    }
    // Hard constraints override logic.
    if (cd !== null && (cstr === 'CS_MSO' || cstr === 'CS_MANDSTART') && w.kind !== 'finish-ms') { rs = cd; re = dur > 0 ? addWorkHours(cal, rs, dur) : rs; finishDrivers = []; startDrivers.length = 0; }
    if (cd !== null && (cstr === 'CS_MEO' || cstr === 'CS_MANDFIN') && w.kind !== 'start-ms') { re = cd; rs = dur > 0 ? addWorkHours(cal, re, -dur) : re; finishDrivers = []; startDrivers.length = 0; }

    const drivers = finishDrivers.length ? finishDrivers : startDrivers;
    for (const e of drivers) { driving.add(e.rel.task_pred_id); n.drivers.push(e.rel.task_pred_id); }
    n.rs = rs; n.re = re;
    if (isActive) { n.es = t.act_start_date!; n.ef = re; }
    else { n.es = rs; n.ef = re; }
  }

  // ---- project finish
  let finish: Ms | null = null;
  for (const n of nodes.values()) if (!n.frozen && (finish === null || n.ef > finish)) finish = n.ef;
  if (finish === null) for (const n of nodes.values()) if (finish === null || n.ef > finish) finish = n.ef;
  if (finish === null) finish = dataDate;
  let lf0 = finish;
  if (so.useProjEndForFloat && s.project.plan_end_date !== null && s.project.plan_end_date > finish) lf0 = s.project.plan_end_date;

  // ---- backward pass
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!; const w = work.get(id)!; const t = w.t; const cal = w.cal; const n = nodes.get(id)!;
    if (n.frozen) continue;
    const succs = succsOf.get(id) ?? [];
    const F: Ms[] = [lf0]; const S: Ms[] = [];
    for (const e of succs) {
      const c = nodes.get(e.succ)!;
      if (c.frozen) continue; // completed successors impose nothing
      const cLs = c.rls; const cLf = c.rlf;
      if (e.type === 'PR_FS') F.push(addWorkHours(e.lagCal, cLs, -e.lag));
      else if (e.type === 'PR_SS') S.push(addWorkHours(e.lagCal, cLs, -e.lag));
      else if (e.type === 'PR_FF') F.push(addWorkHours(e.lagCal, cLf, -e.lag));
      else if (e.type === 'PR_SF') S.push(addWorkHours(e.lagCal, cLf, -e.lag));
    }
    const cstr = t.cstr_type; const cd = t.cstr_date;
    if (cd !== null) { if (cstr === 'CS_MEOB') F.push(cd); else if (cstr === 'CS_MSOB') S.push(cd); }
    const dur = w.dur;
    let lf: Ms; let ls: Ms;
    if (w.kind === 'finish-ms' || w.kind === 'start-ms') {
      let best = Math.min(...F, ...S);
      ls = lf = best;
    } else {
      lf = prevWorkEnd(cal, Math.min(...F));
      if (lf < Math.min(...F) - EPS && dur === 0) lf = Math.min(...F);
      if (S.length) {
        const lsFromS = nextWorkStart(cal, Math.min(...S));
        const lfFromS = dur > 0 ? addWorkHours(cal, lsFromS, dur) : lsFromS;
        if (lfFromS < lf) lf = lfFromS;
      }
      ls = dur > 0 ? addWorkHours(cal, lf, -dur) : lf;
    }
    if (cd !== null && (cstr === 'CS_MSO' || cstr === 'CS_MANDSTART') && w.kind !== 'finish-ms') { ls = cd; lf = dur > 0 ? addWorkHours(cal, ls, dur) : ls; }
    if (cd !== null && (cstr === 'CS_MEO' || cstr === 'CS_MANDFIN') && w.kind !== 'start-ms') { lf = cd; ls = dur > 0 ? addWorkHours(cal, lf, -dur) : lf; }
    n.rls = ls; n.rlf = lf;
    const isActive = t.status_code === 'TK_Active' && t.act_start_date !== null;
    n.ls = isActive ? n.es : ls; n.lf = lf;
    // floats
    const ffin = workHoursBetween(cal, n.re, n.rlf);
    const fstart = workHoursBetween(cal, n.rs, n.rls);
    n.tf = so.floatType === 'FT_SF' ? fstart : so.floatType === 'FT_SMALLEST' ? Math.min(ffin, fstart) : ffin;
    n.tf = Math.round(n.tf * 100) / 100;
  }

  // ---- free float + critical + longest path
  const crit = s.project.critical_drtn_hr_cnt;
  for (const [id, n] of nodes) {
    if (n.frozen) continue;
    const w = work.get(id)!;
    const succs = (succsOf.get(id) ?? []).filter((e) => !nodes.get(e.succ)!.frozen);
    let ff: number | null = null;
    for (const e of succs) {
      const c = nodes.get(e.succ)!;
      let slack: number;
      if (e.type === 'PR_FS') slack = workHoursBetween(w.cal, addWorkHours(e.lagCal, n.ef, e.lag), c.rs);
      else if (e.type === 'PR_SS') slack = workHoursBetween(w.cal, addWorkHours(e.lagCal, n.es, e.lag), c.rs);
      else if (e.type === 'PR_FF') slack = workHoursBetween(w.cal, addWorkHours(e.lagCal, n.ef, e.lag), c.re);
      else slack = workHoursBetween(w.cal, addWorkHours(e.lagCal, n.es, e.lag), c.re);
      slack = Math.max(0, Math.round(slack * 100) / 100);
      if (ff === null || slack < ff) ff = slack;
    }
    if (ff === null) ff = Math.max(0, Math.round(workHoursBetween(w.cal, n.re, finish) * 100) / 100);
    n.ff = Math.min(ff, n.tf ?? ff);
    n.critical = n.tf !== null && n.tf <= crit;
  }
  const longest: number[] = [];
  {
    const seen = new Set<number>();
    const stack = [...nodes.values()].filter((n) => !n.frozen && Math.abs(n.ef - finish) <= EPS).map((n) => n.id);
    while (stack.length) {
      const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id);
      const n = nodes.get(id)!; n.onLongestPath = true; longest.push(id);
      for (const relId of n.drivers) { const r = s.rel(relId)!; if (!nodes.get(r.pred_task_id)!.frozen) stack.push(r.pred_task_id); }
    }
    longest.sort((a, b) => nodes.get(a)!.es - nodes.get(b)!.es);
  }

  return { dataDate, finish, nodes, driving, longestPath: longest, warnings, ms: Math.round(performance.now() - t0) };
}

function findLoop(left: Set<number>, succsOf: Map<number, Edge[]>): number[] {
  const color = new Map<number, number>(); const parent = new Map<number, number>();
  for (const start of left) {
    if (color.get(start)) continue;
    const stack: [number, number][] = [[start, 0]];
    color.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const [u, i] = top;
      const edges = (succsOf.get(u) ?? []).filter((e) => left.has(e.succ));
      if (i < edges.length) {
        top[1] = i + 1;
        const v = edges[i]!.succ;
        if (color.get(v) === 1) {
          const loop = [v]; let x = u; while (x !== v) { loop.push(x); x = parent.get(x)!; } loop.push(v);
          return loop.reverse();
        }
        if (!color.get(v)) { color.set(v, 1); parent.set(v, u); stack.push([v, 0]); }
      } else { color.set(u, 2); stack.pop(); }
    }
  }
  return [...left].slice(0, 3);
}

/** Write the CPM result into the TASK/PROJECT rows. Returns only fields that changed. */
export function applyCpm(s: Schedule, r: CpmResult): FieldChange[] {
  const ch: FieldChange[] = [];
  const push = (c: FieldChange | null) => { if (c) ch.push(c); };
  for (const [id, n] of r.nodes) {
    const t = s.task(id)!;
    if (n.frozen) continue;
    const has = (f: string) => t.table.has(f);
    if (n.status === 'TK_NotStart') {
      push(t.setDate('early_start_date', n.es)); push(t.setDate('early_end_date', n.ef));
      push(t.setDate('late_start_date', n.ls)); push(t.setDate('late_end_date', n.lf));
      push(t.setDate('target_start_date', n.es)); push(t.setDate('target_end_date', n.ef));
      if (has('restart_date')) push(t.setDate('restart_date', n.es));
      if (has('reend_date')) push(t.setDate('reend_date', n.ef));
      if (has('rem_late_start_date')) push(t.setDate('rem_late_start_date', n.ls));
      if (has('rem_late_end_date')) push(t.setDate('rem_late_end_date', n.lf));
    } else {
      if (!t.early_start_date) push(t.setDate('early_start_date', n.es));
      push(t.setDate('early_end_date', n.ef));
      push(t.setDate('late_end_date', n.lf));
      if (!t.late_start_date) push(t.setDate('late_start_date', n.ls));
      if (has('restart_date')) push(t.setDate('restart_date', n.rs));
      if (has('reend_date')) push(t.setDate('reend_date', n.re));
      if (has('rem_late_start_date')) push(t.setDate('rem_late_start_date', n.rls));
      if (has('rem_late_end_date')) push(t.setDate('rem_late_end_date', n.rlf));
    }
    push(t.setHours('total_float_hr_cnt', n.tf)); push(t.setHours('free_float_hr_cnt', n.ff));
    if (has('driving_path_flag')) push(t.set('driving_path_flag', n.onLongestPath ? 'Y' : 'N'));
  }
  push(s.project.setDate('scd_end_date', r.finish));
  if (ch.length) s.touch();
  return ch;
}

export interface ChainStep { task_id: number; code: string; name: string; es: string; ef: string; tf: number | null; via: string | null }

/** Walk driving relationships back from (or forward from) a task. */
export function drivingChain(s: Schedule, r: CpmResult, taskId: number, dir: 'back' | 'forward' = 'back', maxDepth = 30): ChainStep[] {
  const out: ChainStep[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = taskId; let via: string | null = null;
  for (let i = 0; i < maxDepth && cur !== undefined && !seen.has(cur); i++) {
    seen.add(cur);
    const t = s.task(cur); const n = r.nodes.get(cur);
    if (!t || !n) break;
    out.push({ task_id: cur, code: t.task_code, name: t.task_name, es: fmtP6Date(n.es), ef: fmtP6Date(n.ef), tf: n.tf, via });
    let next: RelView | undefined;
    if (dir === 'back') next = n.drivers.map((id) => s.rel(id)!).find(Boolean);
    else next = s.succsOf(cur).find((rel) => r.driving.has(rel.task_pred_id));
    if (!next) break;
    via = `${next.short}${next.lag_hr_cnt ? (next.lag_hr_cnt > 0 ? '+' : '') + next.lag_hr_cnt + 'h' : ''}`;
    cur = dir === 'back' ? next.pred_task_id : next.task_id;
  }
  return out;
}
