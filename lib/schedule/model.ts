import type { XerFile, XerTable } from '../xer/types.ts';
import { fmtHours, fmtP6Date, nowP6, parseP6Date, type Ms } from './dates.ts';
import { buildCal, type CalendarRowLike, type WorkCal } from './calendar.ts';

export type TaskType = 'TT_Task' | 'TT_Mile' | 'TT_FinMile' | 'TT_LOE' | 'TT_Rsrc' | 'TT_WBS';
export type StatusCode = 'TK_NotStart' | 'TK_Active' | 'TK_Complete';
export type PredType = 'PR_FS' | 'PR_SS' | 'PR_FF' | 'PR_SF';
export type CstrType = '' | 'CS_MSO' | 'CS_MSOA' | 'CS_MSOB' | 'CS_MEO' | 'CS_MEOA' | 'CS_MEOB' | 'CS_MANDSTART' | 'CS_MANDFIN' | 'CS_ALAP';

export interface FieldChange { table: string; id: number; field: string; from: string; to: string }

export class ModelError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelError'; }
}

// ---- Table: field-indexed access to a raw ragged table ------------------------------

export class Table {
  readonly idx = new Map<string, number>();
  readonly t: XerTable;
  constructor(t: XerTable) {
    this.t = t;
    t.fields.forEach((f, i) => this.idx.set(f, i));
  }
  get name() { return this.t.name; }
  get rows() { return this.t.rows; }
  get fields() { return this.t.fields; }
  has(f: string) { return this.idx.has(f); }
  col(f: string): number {
    const i = this.idx.get(f);
    if (i === undefined) throw new ModelError(`table ${this.t.name} has no column ${f}`);
    return i;
  }
  get(row: string[], f: string): string {
    const i = this.idx.get(f);
    return i === undefined ? '' : (row[i] ?? '');
  }
  /** Set a value; pads with '' as needed and trims trailing '' like P6 does. */
  set(row: string[], f: string, v: string): void {
    const i = this.col(f);
    while (row.length < i) row.push('');
    if (row.length === i) row.push(v); else row[i] = v;
    while (row.length > 0 && row[row.length - 1] === '') row.pop();
  }
  rowsWhere(f: string, v: string): string[][] {
    const i = this.col(f);
    return this.t.rows.filter((r) => (r[i] ?? '') === v);
  }
  maxId(f: string): number {
    const i = this.col(f);
    let m = 0;
    for (const r of this.t.rows) { const n = +(r[i] ?? ''); if (n > m) m = n; }
    return m;
  }
}

// ---- Views ---------------------------------------------------------------------

abstract class RowView {
  readonly table: Table;
  readonly row: string[];
  constructor(table: Table, row: string[]) { this.table = table; this.row = row; }
  s(f: string): string { return this.table.get(this.row, f); }
  n(f: string): number { const v = this.table.get(this.row, f); return v === '' ? 0 : +v; }
  nn(f: string): number | null { const v = this.table.get(this.row, f); return v === '' ? null : +v; }
  d(f: string): Ms | null { return parseP6Date(this.table.get(this.row, f)); }
  set(f: string, v: string | number | Ms | null): FieldChange | null {
    const to = v === null ? '' : typeof v === 'number' ? String(v) : v;
    const from = this.table.get(this.row, f);
    if (from === to) return null;
    this.table.set(this.row, f, to);
    return { table: this.table.name, id: this.id, field: f, from, to };
  }
  setDate(f: string, ms: Ms | null): FieldChange | null { return this.set(f, fmtP6Date(ms)); }
  setHours(f: string, h: number | null): FieldChange | null { return this.set(f, h === null ? '' : fmtHours(h)); }
  abstract get id(): number;
}

export class TaskView extends RowView {
  get id() { return this.n('task_id'); }
  get task_id() { return this.n('task_id'); }
  get proj_id() { return this.n('proj_id'); }
  get wbs_id() { return this.n('wbs_id'); }
  get clndr_id() { return this.n('clndr_id'); }
  get task_code() { return this.s('task_code'); }
  get task_name() { return this.s('task_name'); }
  get task_type() { return (this.s('task_type') || 'TT_Task') as TaskType; }
  get status_code() { return (this.s('status_code') || 'TK_NotStart') as StatusCode; }
  get target_drtn_hr_cnt() { return this.n('target_drtn_hr_cnt'); }
  get remain_drtn_hr_cnt() { return this.n('remain_drtn_hr_cnt'); }
  get cstr_type() { return this.s('cstr_type') as CstrType; }
  get cstr_date() { return this.d('cstr_date'); }
  get act_start_date() { return this.d('act_start_date'); }
  get act_end_date() { return this.d('act_end_date'); }
  get early_start_date() { return this.d('early_start_date'); }
  get early_end_date() { return this.d('early_end_date'); }
  get late_start_date() { return this.d('late_start_date'); }
  get late_end_date() { return this.d('late_end_date'); }
  get target_start_date() { return this.d('target_start_date'); }
  get target_end_date() { return this.d('target_end_date'); }
  get total_float_hr_cnt() { return this.nn('total_float_hr_cnt'); }
  get free_float_hr_cnt() { return this.nn('free_float_hr_cnt'); }
  get driving_path_flag() { return this.s('driving_path_flag') === 'Y'; }
  get phys_complete_pct() { return this.n('phys_complete_pct'); }
  get isMilestone() { return this.task_type === 'TT_Mile' || this.task_type === 'TT_FinMile'; }
  /** Dates to draw: actuals where they exist, else early dates. */
  get start(): Ms | null { return this.act_start_date ?? this.early_start_date ?? this.target_start_date; }
  get finish(): Ms | null { return this.act_end_date ?? this.early_end_date ?? this.target_end_date; }
}

export class RelView extends RowView {
  get id() { return this.n('task_pred_id'); }
  get task_pred_id() { return this.n('task_pred_id'); }
  get task_id() { return this.n('task_id'); }
  get pred_task_id() { return this.n('pred_task_id'); }
  get pred_type() { return (this.s('pred_type') || 'PR_FS') as PredType; }
  get lag_hr_cnt() { return this.n('lag_hr_cnt'); }
  get short() { return this.pred_type.slice(3); }
}

export class WbsView extends RowView {
  get id() { return this.n('wbs_id'); }
  get wbs_id() { return this.n('wbs_id'); }
  get proj_id() { return this.n('proj_id'); }
  get parent_wbs_id() { return this.nn('parent_wbs_id'); }
  get wbs_short_name() { return this.s('wbs_short_name'); }
  get wbs_name() { return this.s('wbs_name'); }
  get proj_node_flag() { return this.s('proj_node_flag') === 'Y'; }
  get seq_num() { return this.n('seq_num'); }
}

export class ProjectView extends RowView {
  get id() { return this.n('proj_id'); }
  get proj_id() { return this.n('proj_id'); }
  get proj_short_name() { return this.s('proj_short_name'); }
  get clndr_id() { return this.n('clndr_id'); }
  get last_recalc_date() { return this.d('last_recalc_date'); }
  get plan_start_date() { return this.d('plan_start_date'); }
  get plan_end_date() { return this.d('plan_end_date'); }
  get scd_end_date() { return this.d('scd_end_date'); }
  get task_code_prefix() { return this.s('task_code_prefix'); }
  get task_code_base() { return this.n('task_code_base'); }
  get task_code_step() { return this.n('task_code_step') || 10; }
  get critical_drtn_hr_cnt() { return this.n('critical_drtn_hr_cnt'); }
  get def_task_type() { return (this.s('def_task_type') || 'TT_Task') as TaskType; }
}

export interface SchedOptions {
  lagCalendar: 'pred' | 'succ' | '24h' | 'project';
  floatType: 'FT_FF' | 'FT_SF' | 'FT_SMALLEST';
  retainedLogic: boolean;
  useProjEndForFloat: boolean;
}

export interface NewActivity {
  task_name: string;
  wbs_id: number;
  target_drtn_hr_cnt?: number;
  task_code?: string;
  clndr_id?: number;
  task_type?: TaskType;
  cstr_type?: CstrType;
  cstr_date?: Ms | null;
  templateTaskId?: number;
}

export interface ActivityPatch {
  task_name?: string;
  task_code?: string;
  wbs_id?: number;
  clndr_id?: number;
  task_type?: TaskType;
  target_drtn_hr_cnt?: number;
  remain_drtn_hr_cnt?: number;
  cstr_type?: CstrType;
  cstr_date?: Ms | null;
}

const TASK_CHILD_TABLES: [string, string][] = [
  ['TASKRSRC', 'task_id'], ['TASKACTV', 'task_id'], ['TASKMEMO', 'task_id'], ['TASKFIN', 'task_id'],
  ['TASKPROC', 'task_id'], ['TASKDOC', 'task_id'], ['TASKNOTE', 'task_id'], ['TASKFDBK', 'task_id'],
];

export function newGuid(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let bin = ''; for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/=+$/, '');
}

// ---- Schedule -----------------------------------------------------------------------

export class Schedule {
  readonly tables = new Map<string, Table>();
  private _project: ProjectView | null = null;
  private byId = new Map<number, TaskView>();
  private byCode = new Map<string, TaskView>();
  private preds = new Map<number, RelView[]>();
  private succs = new Map<number, RelView[]>();
  private relById = new Map<number, RelView>();
  private wbsIdx = new Map<number, WbsView>();
  private calCache = new Map<number, WorkCal>();
  private dirty = true;
  private counters = new Map<string, number>();

  readonly xer: XerFile;
  constructor(xer: XerFile) {
    this.xer = xer;
    for (const t of xer.tables) this.tables.set(t.name, new Table(t));
    for (const req of ['PROJECT', 'CALENDAR', 'PROJWBS', 'TASK']) if (!this.tables.has(req)) throw new ModelError(`XER has no ${req} table`);
    if (!this.tables.has('TASKPRED')) {
      const t: XerTable = { name: 'TASKPRED', fields: ['task_pred_id', 'task_id', 'pred_task_id', 'proj_id', 'pred_proj_id', 'pred_type', 'lag_hr_cnt', 'float_path', 'aref', 'arls'], rows: [] };
      xer.tables.push(t); this.tables.set('TASKPRED', new Table(t));
    }
  }

  table(name: string): Table | undefined { return this.tables.get(name); }
  get T() { return { PROJECT: this.tables.get('PROJECT')!, CALENDAR: this.tables.get('CALENDAR')!, PROJWBS: this.tables.get('PROJWBS')!, TASK: this.tables.get('TASK')!, TASKPRED: this.tables.get('TASKPRED')! }; }

  touch() { this.dirty = true; }

  private reindex() {
    if (!this.dirty) return;
    this.byId.clear(); this.byCode.clear(); this.preds.clear(); this.succs.clear(); this.relById.clear(); this.wbsIdx.clear();
    const T = this.T;
    for (const r of T.TASK.rows) { const v = new TaskView(T.TASK, r); this.byId.set(v.task_id, v); this.byCode.set(v.task_code, v); }
    for (const r of T.TASKPRED.rows) {
      const v = new RelView(T.TASKPRED, r);
      this.relById.set(v.task_pred_id, v);
      (this.preds.get(v.task_id) ?? this.preds.set(v.task_id, []).get(v.task_id)!).push(v);
      (this.succs.get(v.pred_task_id) ?? this.succs.set(v.pred_task_id, []).get(v.pred_task_id)!).push(v);
    }
    for (const r of T.PROJWBS.rows) { const v = new WbsView(T.PROJWBS, r); this.wbsIdx.set(v.wbs_id, v); }
    this.dirty = false;
  }

  get project(): ProjectView {
    if (!this._project) {
      const T = this.T;
      // Prefer the project whose export_flag is Y, else the first.
      const rows = T.PROJECT.rows;
      const r = rows.find((x) => T.PROJECT.get(x, 'export_flag') === 'Y') ?? rows[0];
      if (!r) throw new ModelError('XER has no PROJECT row');
      this._project = new ProjectView(T.PROJECT, r);
    }
    return this._project;
  }

  get schedOptions(): SchedOptions {
    const t = this.tables.get('SCHEDOPTIONS');
    const r = t?.rows.find((x) => t.get(x, 'proj_id') === String(this.project.proj_id)) ?? t?.rows[0];
    const g = (f: string) => (t && r ? t.get(r, f) : '');
    const lag = g('sched_calendar_on_relationship_lag');
    return {
      lagCalendar: lag === 'rcal_Successor' ? 'succ' : lag === 'rcal_24Hour' ? '24h' : lag === 'rcal_Project' ? 'project' : 'pred',
      floatType: (g('sched_float_type') || 'FT_FF') as SchedOptions['floatType'],
      retainedLogic: g('sched_retained_logic') !== 'N',
      useProjEndForFloat: g('sched_use_project_end_date_for_float') === 'Y',
    };
  }

  get dataDate(): Ms {
    return this.project.last_recalc_date ?? this.project.plan_start_date ?? Date.UTC(2000, 0, 1);
  }

  // ---- reads
  tasks(): TaskView[] { this.reindex(); return [...this.byId.values()]; }
  task(id: number): TaskView | undefined { this.reindex(); return this.byId.get(id); }
  taskByCode(code: string): TaskView | undefined {
    this.reindex();
    return this.byCode.get(code) ?? [...this.byCode.entries()].find(([k]) => k.toLowerCase() === code.toLowerCase())?.[1];
  }
  rels(): RelView[] { this.reindex(); return [...this.relById.values()]; }
  rel(id: number): RelView | undefined { this.reindex(); return this.relById.get(id); }
  predsOf(taskId: number): RelView[] { this.reindex(); return this.preds.get(taskId) ?? []; }
  succsOf(taskId: number): RelView[] { this.reindex(); return this.succs.get(taskId) ?? []; }
  wbs(): WbsView[] { this.reindex(); return [...this.wbsIdx.values()]; }
  wbsById(id: number): WbsView | undefined { this.reindex(); return this.wbsIdx.get(id); }
  wbsByShortName(s: string): WbsView | undefined {
    const all = this.wbs();
    return all.find((w) => w.wbs_short_name === s) ?? all.find((w) => w.wbs_short_name.toLowerCase() === s.toLowerCase()) ?? all.find((w) => w.wbs_name.toLowerCase() === s.toLowerCase());
  }
  wbsRoot(): WbsView | undefined { return this.wbs().find((w) => w.proj_node_flag && w.proj_id === this.project.proj_id) ?? this.wbs()[0]; }
  wbsChildren(id: number): WbsView[] { return this.wbs().filter((w) => w.parent_wbs_id === id).sort((a, b) => a.seq_num - b.seq_num); }
  /** The node itself plus every descendant. */
  wbsDescendants(id: number): number[] {
    const out = [id]; const q = [id];
    while (q.length) { const x = q.shift()!; for (const c of this.wbsChildren(x)) { out.push(c.wbs_id); q.push(c.wbs_id); } }
    return out;
  }
  wbsPath(id: number): string {
    const parts: string[] = []; let w = this.wbsById(id); let guard = 0;
    while (w && guard++ < 50) { parts.unshift(w.wbs_short_name); w = w.parent_wbs_id ? this.wbsById(w.parent_wbs_id) : undefined; }
    return parts.join('.');
  }

  calendarRows(): CalendarRowLike[] {
    const t = this.T.CALENDAR;
    return t.rows.map((r) => ({ clndr_id: +t.get(r, 'clndr_id'), clndr_name: t.get(r, 'clndr_name'), day_hr_cnt: +t.get(r, 'day_hr_cnt'), base_clndr_id: t.get(r, 'base_clndr_id') ? +t.get(r, 'base_clndr_id') : null, clndr_data: t.get(r, 'clndr_data') }));
  }
  calendar(id: number): WorkCal {
    let c = this.calCache.get(id);
    if (c) return c;
    const rows = this.calendarRows();
    const all = new Map(rows.map((r) => [r.clndr_id, r]));
    const row = all.get(id) ?? all.get(this.project.clndr_id) ?? rows[0];
    if (!row) throw new ModelError('XER has no CALENDAR rows');
    c = buildCal(row, all);
    this.calCache.set(id, c);
    return c;
  }
  calendarFor(t: TaskView): WorkCal { return this.calendar(t.clndr_id || this.project.clndr_id); }
  invalidateCalendars() { this.calCache.clear(); }

  // ---- ids
  nextId(table: string, field: string): number {
    const key = `${table}.${field}`;
    const t = this.tables.get(table);
    let n = this.counters.get(key) ?? (t ? t.maxId(field) : 0);
    n += 1;
    this.counters.set(key, n);
    return n;
  }
  nextTaskCode(): string {
    const p = this.project;
    const prefix = p.task_code_prefix;
    let max = p.task_code_base - p.task_code_step;
    for (const t of this.tasks()) {
      const code = t.task_code;
      if (prefix && !code.startsWith(prefix)) continue;
      const num = +code.slice(prefix.length);
      if (Number.isFinite(num) && num > max) max = num;
    }
    let code = `${prefix}${max + p.task_code_step}`;
    while (this.taskByCode(code)) code = `${prefix}${+code.slice(prefix.length) + p.task_code_step}`;
    return code;
  }

  // ---- mutations
  addActivity(input: NewActivity): TaskView {
    const T = this.T;
    const projId = this.project.proj_id;
    const wbs = this.wbsById(input.wbs_id);
    if (!wbs) throw new ModelError(`WBS ${input.wbs_id} does not exist`);
    const type = input.task_type ?? this.project.def_task_type ?? 'TT_Task';
    const dur = type === 'TT_Mile' || type === 'TT_FinMile' ? 0 : Math.max(0, input.target_drtn_hr_cnt ?? 8 * 5);
    const code = input.task_code ?? this.nextTaskCode();
    if (this.taskByCode(code)) throw new ModelError(`activity code ${code} already exists`);
    if (type === 'TT_FinMile' && input.cstr_type && /START|MSO/.test(input.cstr_type)) throw new ModelError('a finish milestone cannot carry a start constraint');
    if (type === 'TT_Mile' && input.cstr_type && /FIN|MEO/.test(input.cstr_type)) throw new ModelError('a start milestone cannot carry a finish constraint');

    const tasks = this.tasks();
    const template = (input.templateTaskId && this.task(input.templateTaskId)?.row)
      ?? tasks.find((t) => t.wbs_id === input.wbs_id && t.task_type === 'TT_Task')?.row
      ?? tasks.find((t) => t.clndr_id === (input.clndr_id ?? 0))?.row
      ?? tasks.find((t) => t.task_type === 'TT_Task')?.row
      ?? tasks[0]?.row;
    const row: string[] = template ? [...template] : [];
    const id = this.nextId('TASK', 'task_id');
    const clndr = input.clndr_id ?? (template ? +T.TASK.get(template, 'clndr_id') : 0);
    const now = nowP6();
    const defaults: Record<string, string> = {
      task_id: String(id), proj_id: String(projId), wbs_id: String(input.wbs_id), clndr_id: String(clndr || this.project.clndr_id),
      phys_complete_pct: '0', rev_fdbk_flag: 'N', lock_plan_flag: 'N', auto_compute_act_flag: 'Y',
      complete_pct_type: template ? T.TASK.get(template, 'complete_pct_type') || 'CP_Drtn' : 'CP_Drtn',
      task_type: type, duration_type: template ? T.TASK.get(template, 'duration_type') || 'DT_FixedDrtn' : 'DT_FixedDrtn',
      status_code: 'TK_NotStart', task_code: code, task_name: input.task_name, rsrc_id: '',
      total_float_hr_cnt: '', free_float_hr_cnt: '', remain_drtn_hr_cnt: fmtHours(dur),
      act_work_qty: '0', remain_work_qty: '0', target_work_qty: '0', target_drtn_hr_cnt: fmtHours(dur),
      target_equip_qty: '0', act_equip_qty: '0', remain_equip_qty: '0',
      cstr_date: fmtP6Date(input.cstr_date ?? null), act_start_date: '', act_end_date: '', late_start_date: '', late_end_date: '',
      expect_end_date: '', early_start_date: '', early_end_date: '', restart_date: '', reend_date: '', target_start_date: '', target_end_date: '',
      rem_late_start_date: '', rem_late_end_date: '', cstr_type: input.cstr_type ?? '', priority_type: 'PT_Normal', suspend_date: '', resume_date: '',
      float_path: '', float_path_order: '', guid: newGuid(), tmpl_guid: '', cstr_date2: '', cstr_type2: '', driving_path_flag: 'N',
      act_this_per_work_qty: '0', act_this_per_equip_qty: '0', external_early_start_date: '', external_late_end_date: '',
      create_date: now, update_date: now, create_user: this.xer.header[3] ?? 'admin', update_user: this.xer.header[3] ?? 'admin', location_id: '',
    };
    for (const [f, v] of Object.entries(defaults)) if (T.TASK.has(f)) T.TASK.set(row, f, v);
    T.TASK.rows.push(row);
    this.touch();
    return this.task(id)!;
  }

  updateActivity(id: number, patch: ActivityPatch): FieldChange[] {
    const t = this.task(id);
    if (!t) throw new ModelError(`activity ${id} does not exist`);
    const ch: FieldChange[] = [];
    const push = (c: FieldChange | null) => { if (c) ch.push(c); };
    if (patch.task_code !== undefined && patch.task_code !== t.task_code) {
      if (this.taskByCode(patch.task_code)) throw new ModelError(`activity code ${patch.task_code} already exists`);
      push(t.set('task_code', patch.task_code));
    }
    if (patch.task_name !== undefined) push(t.set('task_name', patch.task_name));
    if (patch.wbs_id !== undefined) { if (!this.wbsById(patch.wbs_id)) throw new ModelError(`WBS ${patch.wbs_id} does not exist`); push(t.set('wbs_id', patch.wbs_id)); }
    if (patch.clndr_id !== undefined) { this.calendar(patch.clndr_id); push(t.set('clndr_id', patch.clndr_id)); }
    if (patch.task_type !== undefined) {
      push(t.set('task_type', patch.task_type));
      if (patch.task_type === 'TT_Mile' || patch.task_type === 'TT_FinMile') { push(t.setHours('target_drtn_hr_cnt', 0)); push(t.setHours('remain_drtn_hr_cnt', 0)); }
    }
    if (patch.target_drtn_hr_cnt !== undefined) {
      if (t.isMilestone && patch.target_drtn_hr_cnt !== 0) throw new ModelError(`${t.task_code} is a milestone; it cannot have a duration`);
      const d = Math.max(0, patch.target_drtn_hr_cnt);
      push(t.setHours('target_drtn_hr_cnt', d));
      if (t.status_code === 'TK_NotStart') push(t.setHours('remain_drtn_hr_cnt', d));
      else if (t.status_code === 'TK_Active' && patch.remain_drtn_hr_cnt === undefined) push(t.setHours('remain_drtn_hr_cnt', Math.max(0, d - (t.target_drtn_hr_cnt - t.remain_drtn_hr_cnt))));
    }
    if (patch.remain_drtn_hr_cnt !== undefined) {
      if (t.status_code === 'TK_Complete') throw new ModelError(`${t.task_code} is complete; remaining duration is fixed at 0`);
      push(t.setHours('remain_drtn_hr_cnt', Math.max(0, patch.remain_drtn_hr_cnt)));
      if (t.status_code === 'TK_NotStart') push(t.setHours('target_drtn_hr_cnt', Math.max(0, patch.remain_drtn_hr_cnt)));
    }
    if (patch.cstr_type !== undefined) {
      if (t.task_type === 'TT_FinMile' && /START|MSO/.test(patch.cstr_type)) throw new ModelError('a finish milestone cannot carry a start constraint');
      if (t.task_type === 'TT_Mile' && /FIN|MEO/.test(patch.cstr_type)) throw new ModelError('a start milestone cannot carry a finish constraint');
      push(t.set('cstr_type', patch.cstr_type));
      if (patch.cstr_type === '') push(t.set('cstr_date', ''));
    }
    if (patch.cstr_date !== undefined) push(t.setDate('cstr_date', patch.cstr_date));
    if (t.cstr_type && !t.cstr_date) throw new ModelError(`constraint ${t.cstr_type} on ${t.task_code} needs a date`);
    if (ch.length) { push(t.set('update_date', nowP6())); this.touch(); }
    return ch;
  }

  deleteActivity(id: number): { table: string; removed: number }[] {
    const t = this.task(id);
    if (!t) throw new ModelError(`activity ${id} does not exist`);
    const out: { table: string; removed: number }[] = [];
    const sid = String(id);
    const TP = this.T.TASKPRED;
    const before = TP.rows.length;
    TP.t.rows = TP.rows.filter((r) => TP.get(r, 'task_id') !== sid && TP.get(r, 'pred_task_id') !== sid);
    if (TP.rows.length !== before) out.push({ table: 'TASKPRED', removed: before - TP.rows.length });
    for (const [name, field] of TASK_CHILD_TABLES) {
      const tb = this.tables.get(name); if (!tb || !tb.has(field)) continue;
      const b = tb.rows.length;
      tb.t.rows = tb.rows.filter((r) => tb.get(r, field) !== sid);
      if (tb.rows.length !== b) out.push({ table: name, removed: b - tb.rows.length });
    }
    const udf = this.tables.get('UDFVALUE'); const udft = this.tables.get('UDFTYPE');
    if (udf && udft && udf.has('fk_id') && udf.has('udf_type_id')) {
      const taskTypes = new Set(udft.rows.filter((r) => udft.get(r, 'table_name') === 'TASK').map((r) => udft.get(r, 'udf_type_id')));
      const b = udf.rows.length;
      udf.t.rows = udf.rows.filter((r) => !(udf.get(r, 'fk_id') === sid && taskTypes.has(udf.get(r, 'udf_type_id'))));
      if (udf.rows.length !== b) out.push({ table: 'UDFVALUE', removed: b - udf.rows.length });
    }
    const TK = this.T.TASK;
    TK.t.rows = TK.rows.filter((r) => r !== t.row);
    out.push({ table: 'TASK', removed: 1 });
    this.touch();
    return out;
  }

  addRelationship(input: { pred_task_id: number; task_id: number; pred_type?: PredType; lag_hr_cnt?: number }): RelView {
    if (input.pred_task_id === input.task_id) throw new ModelError('an activity cannot be its own predecessor');
    const pred = this.task(input.pred_task_id); const succ = this.task(input.task_id);
    if (!pred) throw new ModelError(`predecessor ${input.pred_task_id} does not exist`);
    if (!succ) throw new ModelError(`successor ${input.task_id} does not exist`);
    const type = input.pred_type ?? 'PR_FS';
    if (this.predsOf(succ.task_id).some((r) => r.pred_task_id === pred.task_id && r.pred_type === type)) throw new ModelError(`${pred.task_code} -> ${succ.task_code} ${type.slice(3)} already exists`);
    const TP = this.T.TASKPRED;
    const row: string[] = [];
    const id = this.nextId('TASKPRED', 'task_pred_id');
    const vals: Record<string, string> = { task_pred_id: String(id), task_id: String(succ.task_id), pred_task_id: String(pred.task_id), proj_id: String(succ.proj_id), pred_proj_id: String(pred.proj_id), pred_type: type, lag_hr_cnt: fmtHours(input.lag_hr_cnt ?? 0), float_path: '', aref: '', arls: '' };
    for (const [f, v] of Object.entries(vals)) if (TP.has(f)) TP.set(row, f, v);
    TP.rows.push(row);
    this.touch();
    return this.rel(id)!;
  }

  updateRelationship(id: number, patch: { pred_type?: PredType; lag_hr_cnt?: number }): FieldChange[] {
    const r = this.rel(id);
    if (!r) throw new ModelError(`relationship ${id} does not exist`);
    const ch: FieldChange[] = [];
    if (patch.pred_type !== undefined && patch.pred_type !== r.pred_type) {
      if (this.predsOf(r.task_id).some((x) => x !== r && x.pred_task_id === r.pred_task_id && x.pred_type === patch.pred_type)) throw new ModelError(`that ${patch.pred_type.slice(3)} relationship already exists`);
      const c = r.set('pred_type', patch.pred_type); if (c) ch.push(c);
    }
    if (patch.lag_hr_cnt !== undefined) { const c = r.setHours('lag_hr_cnt', patch.lag_hr_cnt); if (c) ch.push(c); }
    if (ch.length) this.touch();
    return ch;
  }

  deleteRelationship(id: number): void {
    const r = this.rel(id);
    if (!r) throw new ModelError(`relationship ${id} does not exist`);
    const TP = this.T.TASKPRED;
    TP.t.rows = TP.rows.filter((x) => x !== r.row);
    this.touch();
  }

  addWbs(input: { wbs_name: string; wbs_short_name: string; parent_wbs_id: number }): WbsView {
    const parent = this.wbsById(input.parent_wbs_id);
    if (!parent) throw new ModelError(`WBS ${input.parent_wbs_id} does not exist`);
    const siblings = this.wbsChildren(parent.wbs_id);
    if (siblings.some((w) => w.wbs_short_name === input.wbs_short_name)) throw new ModelError(`WBS code ${input.wbs_short_name} already exists under ${parent.wbs_short_name}`);
    const W = this.T.PROJWBS;
    const id = this.nextId('PROJWBS', 'wbs_id');
    const row: string[] = [];
    const vals: Record<string, string> = {
      wbs_id: String(id), proj_id: String(parent.proj_id), obs_id: W.get(parent.row, 'obs_id'), seq_num: String((siblings.at(-1)?.seq_num ?? 0) + 10),
      proj_node_flag: 'N', sum_data_flag: 'N', status_code: 'WS_Open', wbs_short_name: input.wbs_short_name, wbs_name: input.wbs_name,
      phase_id: '', parent_wbs_id: String(parent.wbs_id), ev_user_pct: '', ev_etc_user_value: '', orig_cost: '0.00', indep_remain_total_cost: '0.00',
      ann_dscnt_rate_pct: '', dscnt_period_type: '', indep_remain_work_qty: '', anticip_start_date: '', anticip_end_date: '',
      ev_compute_type: W.get(parent.row, 'ev_compute_type') || 'EC_Cmp_pct', ev_etc_compute_type: W.get(parent.row, 'ev_etc_compute_type') || 'EE_Rem_hr', guid: newGuid(), tmpl_guid: '', plan_open_state: '',
    };
    for (const [f, v] of Object.entries(vals)) if (W.has(f)) W.set(row, f, v);
    W.rows.push(row);
    this.touch();
    return this.wbsById(id)!;
  }

  setDataDate(ms: Ms): FieldChange[] {
    const c = this.project.setDate('last_recalc_date', ms);
    return c ? [c] : [];
  }
}
