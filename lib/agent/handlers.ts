import { z } from 'zod';
import type { Document } from '../state.ts';
import { checkLogic, filterTasks, resolveWbs, rowOf, sortTasks, summary, type Filter } from '../schedule/analyze.ts';
import { drivingChain } from '../schedule/cpm.ts';
import { fmtP6Date, parseP6Date, type Ms } from '../schedule/dates.ts';
import { addWorkHours, nextWorkStart } from '../schedule/calendar.ts';
import { isCp1252, toCp1252 } from '../xer/encoding.ts';
import type { CompactDiff } from '../schedule/diff.ts';
import type { CstrType, PredType, Schedule, TaskView } from '../schedule/model.ts';

// ---- schemas ------------------------------------------------------------------------

const Code = z.string().min(1).describe('activity code, e.g. A1230');
const Duration = z.object({ days: z.number().optional(), hours: z.number().optional() }).describe('{days: n} (converted with the activity calendar) or {hours: n}');
const P6Date = z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/).describe("'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM'");
const RelType = z.enum(['FS', 'SS', 'FF', 'SF']);
const CstrShort = z.enum(['MSO', 'MSOA', 'MSOB', 'MEO', 'MEOA', 'MEOB', 'MANDSTART', 'MANDFIN', 'ALAP']);
const WbsRef = z.union([z.number(), z.string()]).describe('WBS id, short code (e.g. MEP) or name');
const FilterShape = {
  q: z.string().optional().describe('words matched against code, name and WBS name'),
  wbs: WbsRef.optional().describe('limit to a WBS node and its descendants'),
  status: z.enum(['NotStart', 'Active', 'Complete']).optional(),
  type: z.enum(['Task', 'Mile', 'FinMile', 'LOE']).optional(),
  critical: z.boolean().optional(),
  float_lte: z.number().optional().describe('total float <= this many hours'),
  constrained: z.boolean().optional(),
  start_after: P6Date.optional(),
  finish_before: P6Date.optional(),
  codes: z.array(Code).optional(),
};
const FilterObj = z.object(FilterShape);

// ---- helpers ------------------------------------------------------------------------

export class ToolError extends Error {}

function hoursOf(d: { days?: number; hours?: number } | undefined, dayHours: number, fallback = 0): number {
  if (!d) return fallback;
  if (d.hours !== undefined) return d.hours;
  if (d.days !== undefined) return d.days * dayHours;
  return fallback;
}
function needTask(s: Schedule, code: string): TaskView {
  const t = s.taskByCode(code);
  if (!t) throw new ToolError(`no activity with code ${code}`);
  return t;
}
function needWbs(s: Schedule, w: number | string): number {
  const id = resolveWbs(s, w);
  if (id === null) throw new ToolError(`WBS "${w}" not found; use list_wbs`);
  return id;
}
function dateArg(v: string | undefined, s: Schedule, t?: TaskView): Ms | null {
  if (!v) return null;
  const ms = parseP6Date(v);
  if (ms === null) throw new ToolError(`bad date ${v}`);
  if (v.length <= 10) { const cal = t ? s.calendarFor(t) : s.calendar(s.project.clndr_id); return nextWorkStart(cal, ms); }
  return ms;
}
function cleanText(v: string): string { return isCp1252(v) ? v : toCp1252(v); }
const pr = (t: 'FS' | 'SS' | 'FF' | 'SF'): PredType => `PR_${t}`;
const cs = (t?: string | null): CstrType => (t ? (`CS_${t}` as CstrType) : '');

function diffSummary(d: CompactDiff): string {
  const parts: string[] = [];
  if (d.added.length) parts.push(`${d.added.length} added`);
  if (d.deleted.length) parts.push(`${d.deleted.length} deleted`);
  if (d.updatedCount) parts.push(`${d.updatedCount} field changes`);
  const r = d.relationships; const rc = r.added.length + r.deleted.length + r.updated.length;
  if (rc) parts.push(`${rc} relationship changes`);
  parts.push(`${d.cpm.moved} activities moved`);
  const delta = d.cpm.finishDeltaDays;
  parts.push(`finish ${d.cpm.finish.to.slice(0, 10)}${delta ? ` (${delta > 0 ? '+' : ''}${delta} work days)` : ' (unchanged)'}`);
  if (d.cpm.negativeFloat) parts.push(`${d.cpm.negativeFloat} with negative float`);
  return parts.join(', ');
}

export interface ToolCtx { doc: () => Document; turn: () => string; saveExport: (name: string, bytes: Uint8Array) => Promise<{ path: string; bytes: number }> }

type Result = { summary: string; diff?: CompactDiff; data?: unknown };

// ---- handlers (pure; tested directly) -----------------------------------------------

export const handlers = {
  async get_summary(ctx: ToolCtx): Promise<Result> {
    const doc = ctx.doc();
    const data = summary(doc.sched, doc.cpm);
    return { summary: `${data.counts.activities} activities, finish ${data.project.finish}`, data };
  },

  async search_activities(ctx: ToolCtx, a: Filter & { limit?: number; offset?: number; sort?: 'es' | 'tf' | 'code' | 'ef' }): Promise<Result> {
    const doc = ctx.doc();
    const all = sortTasks(doc.sched, doc.cpm, filterTasks(doc.sched, doc.cpm, a), a.sort ?? 'es');
    const limit = Math.min(200, Math.max(1, a.limit ?? 50)); const offset = a.offset ?? 0;
    const rows = all.slice(offset, offset + limit).map((t) => rowOf(doc.sched, doc.cpm, t));
    return { summary: `${all.length} match${all.length === 1 ? '' : 'es'}${all.length > rows.length ? `, showing ${offset + 1}-${offset + rows.length}` : ''}`, data: { total: all.length, offset, rows, next_offset: offset + rows.length < all.length ? offset + rows.length : null } };
  },

  async get_activity(ctx: ToolCtx, a: { code: string }): Promise<Result> {
    const doc = ctx.doc(); const s = doc.sched;
    const t = needTask(s, a.code); const n = doc.cpm.nodes.get(t.task_id);
    const cal = s.calendarFor(t);
    const relOf = (r: { pred_task_id: number; task_id: number; short: string; lag_hr_cnt: number; task_pred_id: number }, other: number) => { const o = s.task(other); return { id: r.task_pred_id, code: o?.task_code, name: o?.task_name, type: r.short, lag_h: r.lag_hr_cnt, driving: doc.cpm.driving.has(r.task_pred_id) }; };
    const data = {
      ...rowOf(s, doc.cpm, t), wbs_path: s.wbsPath(t.wbs_id), calendar: { id: cal.id, name: cal.name, day_hours: cal.dayHours },
      dur_days: t.target_drtn_hr_cnt / cal.dayHours, remain_days: t.remain_drtn_hr_cnt / cal.dayHours, pct: t.phys_complete_pct,
      late_start: fmtP6Date(n?.ls ?? t.late_start_date), late_finish: fmtP6Date(n?.lf ?? t.late_end_date), free_float_h: n?.ff ?? t.free_float_hr_cnt,
      actual_start: fmtP6Date(t.act_start_date), actual_finish: fmtP6Date(t.act_end_date), constraint_type: t.cstr_type, constraint_date: fmtP6Date(t.cstr_date),
      predecessors: s.predsOf(t.task_id).map((r) => relOf(r, r.pred_task_id)), successors: s.succsOf(t.task_id).map((r) => relOf(r, r.task_id)),
    };
    return { summary: `${t.task_code} ${t.task_name}: ${data.es} -> ${data.ef}, TF ${data.tf}h`, data };
  },

  async list_wbs(ctx: ToolCtx): Promise<Result> {
    const doc = ctx.doc(); const s = doc.sched; const p = s.project.proj_id;
    const tasks = s.tasks().filter((t) => t.proj_id === p);
    const data = s.wbs().filter((w) => w.proj_id === p).sort((a, b) => a.seq_num - b.seq_num).map((w) => ({ id: w.wbs_id, parent: w.parent_wbs_id, code: w.wbs_short_name, name: w.wbs_name, path: s.wbsPath(w.wbs_id), activities: tasks.filter((t) => t.wbs_id === w.wbs_id).length }));
    return { summary: `${data.length} WBS nodes`, data };
  },

  async trace_driving(ctx: ToolCtx, a: { code?: string; direction?: 'back' | 'forward'; depth?: number }): Promise<Result> {
    const doc = ctx.doc(); const s = doc.sched;
    let id: number;
    if (a.code) id = needTask(s, a.code).task_id;
    else {
      const last = doc.cpm.longestPath.at(-1) ?? [...doc.cpm.nodes.values()].filter((n) => !n.frozen).sort((x, y) => y.ef - x.ef)[0]?.id;
      if (last === undefined) throw new ToolError('no open activities');
      id = last;
    }
    const chain = drivingChain(s, doc.cpm, id, a.direction ?? 'back', a.depth ?? 25);
    return { summary: `${chain.length} activities on the driving chain ${a.direction === 'forward' ? 'from' : 'behind'} ${chain[0]?.code}`, data: { finish: fmtP6Date(doc.cpm.finish), chain } };
  },

  async check_logic(ctx: ToolCtx, a: { limit?: number }): Promise<Result> {
    const doc = ctx.doc();
    const data = checkLogic(doc.sched, doc.cpm, Math.min(200, a.limit ?? 50));
    return { summary: `${data.open_starts.count} open starts, ${data.open_ends.count} open ends, ${data.negative_float.count} negative float, ${data.constraints.count} constrained`, data };
  },

  async add_activity(ctx: ToolCtx, a: { name: string; wbs: number | string; duration?: { days?: number; hours?: number }; code?: string; type?: 'Task' | 'Mile' | 'FinMile'; calendar_id?: number; after?: { code: string; type?: 'FS' | 'SS' | 'FF' | 'SF'; lag?: { days?: number; hours?: number } }; before?: { code: string; type?: 'FS' | 'SS' | 'FF' | 'SF'; lag?: { days?: number; hours?: number } }; constraint?: { type: string; date: string } }): Promise<Result> {
    const doc = ctx.doc();
    let code = '';
    const diff = doc.mutate(ctx.turn(), `add_activity ${a.name}`, (s) => {
      const wbs = needWbs(s, a.wbs);
      const cal = s.calendar(a.calendar_id ?? s.tasks().find((t) => t.wbs_id === wbs)?.clndr_id ?? s.project.clndr_id);
      const type = a.type === 'Mile' ? 'TT_Mile' : a.type === 'FinMile' ? 'TT_FinMile' : 'TT_Task';
      const t = s.addActivity({ task_name: cleanText(a.name), wbs_id: wbs, target_drtn_hr_cnt: hoursOf(a.duration, cal.dayHours, 5 * cal.dayHours), task_code: a.code, clndr_id: a.calendar_id, task_type: type, cstr_type: cs(a.constraint?.type), cstr_date: a.constraint ? dateArg(a.constraint.date, s) : null });
      code = t.task_code;
      if (a.after) { const p = needTask(s, a.after.code); s.addRelationship({ pred_task_id: p.task_id, task_id: t.task_id, pred_type: pr(a.after.type ?? 'FS'), lag_hr_cnt: hoursOf(a.after.lag, s.calendarFor(p).dayHours) }); }
      if (a.before) { const c = needTask(s, a.before.code); s.addRelationship({ pred_task_id: t.task_id, task_id: c.task_id, pred_type: pr(a.before.type ?? 'FS'), lag_hr_cnt: hoursOf(a.before.lag, cal.dayHours) }); }
    });
    return { summary: `added ${code} ${a.name}; ${diffSummary(diff)}`, diff };
  },

  async add_activities(ctx: ToolCtx, a: { activities: { name: string; wbs: number | string; duration?: { days?: number; hours?: number }; code?: string; type?: 'Task' | 'Mile' | 'FinMile'; after?: { code: string; type?: 'FS' | 'SS' | 'FF' | 'SF'; lag?: { days?: number; hours?: number } }; before?: { code: string; type?: 'FS' | 'SS' | 'FF' | 'SF'; lag?: { days?: number; hours?: number } } }[]; chain?: boolean }): Promise<Result> {
    const doc = ctx.doc();
    const codes: string[] = [];
    const diff = doc.mutate(ctx.turn(), `add_activities (${a.activities.length})`, (s) => {
      let prev: TaskView | null = null;
      for (const x of a.activities) {
        const wbs = needWbs(s, x.wbs);
        const cal = s.calendar(s.tasks().find((t) => t.wbs_id === wbs)?.clndr_id ?? s.project.clndr_id);
        const type = x.type === 'Mile' ? 'TT_Mile' : x.type === 'FinMile' ? 'TT_FinMile' : 'TT_Task';
        const t = s.addActivity({ task_name: cleanText(x.name), wbs_id: wbs, target_drtn_hr_cnt: hoursOf(x.duration, cal.dayHours, 5 * cal.dayHours), task_code: x.code, task_type: type });
        codes.push(t.task_code);
        if (x.after) { const p = needTask(s, x.after.code); s.addRelationship({ pred_task_id: p.task_id, task_id: t.task_id, pred_type: pr(x.after.type ?? 'FS'), lag_hr_cnt: hoursOf(x.after.lag, s.calendarFor(p).dayHours) }); }
        else if (a.chain && prev) s.addRelationship({ pred_task_id: prev.task_id, task_id: t.task_id });
        if (x.before) { const c = needTask(s, x.before.code); s.addRelationship({ pred_task_id: t.task_id, task_id: c.task_id, pred_type: pr(x.before.type ?? 'FS'), lag_hr_cnt: hoursOf(x.before.lag, cal.dayHours) }); }
        prev = t;
      }
    });
    return { summary: `added ${codes.length} activities (${codes[0]}..${codes.at(-1)}); ${diffSummary(diff)}`, diff, data: { codes } };
  },

  async update_activities(ctx: ToolCtx, a: { codes?: string[]; filter?: Filter; set: { name?: string; code?: string; duration?: { days?: number; hours?: number }; remaining?: { days?: number; hours?: number }; wbs?: number | string; calendar_id?: number; type?: 'Task' | 'Mile' | 'FinMile'; constraint?: { type: string; date: string } | null } }): Promise<Result> {
    const doc = ctx.doc();
    let n = 0;
    const diff = doc.mutate(ctx.turn(), `update_activities`, (s) => {
      const targets = a.codes?.length ? a.codes.map((c) => needTask(s, c)) : a.filter ? filterTasks(s, doc.cpm, a.filter) : [];
      if (!targets.length) throw new ToolError('no activities matched; give codes or a filter');
      if (targets.length > 1 && a.set.code) throw new ToolError('cannot set the same code on several activities');
      const ch = [];
      for (const t of targets) {
        const cal = s.calendarFor(t);
        ch.push(...s.updateActivity(t.task_id, {
          task_name: a.set.name !== undefined ? cleanText(a.set.name) : undefined, task_code: a.set.code,
          target_drtn_hr_cnt: a.set.duration ? hoursOf(a.set.duration, cal.dayHours) : undefined,
          remain_drtn_hr_cnt: a.set.remaining ? hoursOf(a.set.remaining, cal.dayHours) : undefined,
          wbs_id: a.set.wbs !== undefined ? needWbs(s, a.set.wbs) : undefined, clndr_id: a.set.calendar_id,
          task_type: a.set.type ? (a.set.type === 'Mile' ? 'TT_Mile' : a.set.type === 'FinMile' ? 'TT_FinMile' : 'TT_Task') : undefined,
          cstr_type: a.set.constraint === null ? '' : a.set.constraint ? cs(a.set.constraint.type) : undefined,
          cstr_date: a.set.constraint === null ? null : a.set.constraint ? dateArg(a.set.constraint.date, s, t) : undefined,
        }));
        n++;
      }
      return ch;
    });
    return { summary: `updated ${n} activities; ${diffSummary(diff)}`, diff };
  },

  async delete_activities(ctx: ToolCtx, a: { codes: string[] }): Promise<Result> {
    const doc = ctx.doc();
    const diff = doc.mutate(ctx.turn(), `delete_activities ${a.codes.join(',')}`, (s) => { for (const c of a.codes) s.deleteActivity(needTask(s, c).task_id); });
    return { summary: `deleted ${a.codes.length}; ${diffSummary(diff)}`, diff };
  },

  async add_relationships(ctx: ToolCtx, a: { links: { pred: string; succ: string; type?: 'FS' | 'SS' | 'FF' | 'SF'; lag?: { days?: number; hours?: number } }[] }): Promise<Result> {
    const doc = ctx.doc();
    const diff = doc.mutate(ctx.turn(), `add_relationships (${a.links.length})`, (s) => {
      for (const l of a.links) { const p = needTask(s, l.pred); const c = needTask(s, l.succ); s.addRelationship({ pred_task_id: p.task_id, task_id: c.task_id, pred_type: pr(l.type ?? 'FS'), lag_hr_cnt: hoursOf(l.lag, s.calendarFor(p).dayHours) }); }
    });
    return { summary: `added ${a.links.length} relationships; ${diffSummary(diff)}`, diff };
  },

  async update_relationships(ctx: ToolCtx, a: { ids?: number[]; match?: { pred?: string; succ?: string; wbs?: number | string; type?: 'FS' | 'SS' | 'FF' | 'SF'; within_wbs_only?: boolean }; set: { type?: 'FS' | 'SS' | 'FF' | 'SF'; lag?: { days?: number; hours?: number } } }): Promise<Result> {
    const doc = ctx.doc();
    let n = 0;
    const diff = doc.mutate(ctx.turn(), `update_relationships`, (s) => {
      let rels = s.rels();
      if (a.ids?.length) { const set = new Set(a.ids); rels = rels.filter((r) => set.has(r.task_pred_id)); }
      if (a.match) {
        const m = a.match;
        if (m.pred) { const p = needTask(s, m.pred); rels = rels.filter((r) => r.pred_task_id === p.task_id); }
        if (m.succ) { const c = needTask(s, m.succ); rels = rels.filter((r) => r.task_id === c.task_id); }
        if (m.wbs !== undefined) { const set = new Set(s.wbsDescendants(needWbs(s, m.wbs))); const inW = (id: number) => set.has(s.task(id)?.wbs_id ?? -1); rels = rels.filter((r) => (m.within_wbs_only ?? true) ? inW(r.pred_task_id) && inW(r.task_id) : inW(r.pred_task_id) || inW(r.task_id)); }
        if (m.type) rels = rels.filter((r) => r.pred_type === pr(m.type!));
      }
      if (!a.ids?.length && !a.match) throw new ToolError('give ids or a match');
      if (!rels.length) throw new ToolError('no relationships matched');
      const ch = [];
      for (const r of rels) { ch.push(...s.updateRelationship(r.task_pred_id, { pred_type: a.set.type ? pr(a.set.type) : undefined, lag_hr_cnt: a.set.lag ? hoursOf(a.set.lag, s.calendarFor(s.task(r.pred_task_id)!).dayHours) : undefined })); n++; }
      return ch;
    });
    return { summary: `updated ${n} relationships; ${diffSummary(diff)}`, diff };
  },

  async delete_relationships(ctx: ToolCtx, a: { ids?: number[]; pairs?: { pred: string; succ: string }[] }): Promise<Result> {
    const doc = ctx.doc();
    let n = 0;
    const diff = doc.mutate(ctx.turn(), `delete_relationships`, (s) => {
      for (const id of a.ids ?? []) { s.deleteRelationship(id); n++; }
      for (const p of a.pairs ?? []) { const a1 = needTask(s, p.pred); const b1 = needTask(s, p.succ); for (const r of s.predsOf(b1.task_id).filter((r) => r.pred_task_id === a1.task_id)) { s.deleteRelationship(r.task_pred_id); n++; } }
      if (!n) throw new ToolError('nothing matched');
    });
    return { summary: `deleted ${n} relationships; ${diffSummary(diff)}`, diff };
  },

  async shift_activities(ctx: ToolCtx, a: { codes?: string[]; wbs?: number | string; filter?: Filter; by: { days?: number; hours?: number } }): Promise<Result> {
    const doc = ctx.doc();
    let n = 0; let skipped = 0;
    const diff = doc.mutate(ctx.turn(), `shift_activities`, (s) => {
      let targets: TaskView[] = [];
      if (a.codes?.length) targets = a.codes.map((c) => needTask(s, c));
      else if (a.wbs !== undefined) targets = filterTasks(s, doc.cpm, { wbs: a.wbs });
      else if (a.filter) targets = filterTasks(s, doc.cpm, a.filter);
      if (!targets.length) throw new ToolError('no activities matched');
      const ch = [];
      for (const t of targets) {
        if (t.status_code !== 'TK_NotStart') { skipped++; continue; }
        const cal = s.calendarFor(t);
        const h = hoursOf(a.by, cal.dayHours);
        const n0 = doc.cpm.nodes.get(t.task_id);
        const es = n0?.es ?? t.start ?? s.dataDate;
        const target = h >= 0 ? addWorkHours(cal, es, h) : nextWorkStart(cal, addWorkHours(cal, es, h));
        if (t.task_type === 'TT_FinMile') ch.push(...s.updateActivity(t.task_id, { cstr_type: 'CS_MEOA', cstr_date: h >= 0 ? addWorkHours(cal, n0?.ef ?? es, h) : addWorkHours(cal, n0?.ef ?? es, h) }));
        else ch.push(...s.updateActivity(t.task_id, { cstr_type: 'CS_MSOA', cstr_date: target }));
        n++;
      }
      return ch;
    });
    return { summary: `placed a start-on-or-after constraint on ${n} activities${skipped ? ` (${skipped} in progress or complete skipped)` : ''}; ${diffSummary(diff)}. Note: shifting earlier only works where logic allows.`, diff };
  },

  async add_wbs(ctx: ToolCtx, a: { name: string; code: string; parent: number | string }): Promise<Result> {
    const doc = ctx.doc();
    let id = 0;
    const diff = doc.mutate(ctx.turn(), `add_wbs ${a.code}`, (s) => { id = s.addWbs({ wbs_name: cleanText(a.name), wbs_short_name: cleanText(a.code), parent_wbs_id: needWbs(s, a.parent) }).wbs_id; });
    return { summary: `added WBS ${a.code} (id ${id})`, diff };
  },

  async reschedule(ctx: ToolCtx, a: { data_date?: string }): Promise<Result> {
    const doc = ctx.doc();
    const diff = doc.mutate(ctx.turn(), `reschedule`, (s) => { if (a.data_date) { const d = parseP6Date(a.data_date); if (d === null) throw new ToolError('bad date'); return s.setDataDate(d); } });
    return { summary: `rescheduled; ${diffSummary(diff)}`, diff };
  },

  async undo_last(ctx: ToolCtx, a: { scope?: 'call' | 'turn'; steps?: number }): Promise<Result> {
    const doc = ctx.doc();
    const diff = doc.undo(ctx.turn(), { scope: a.scope ?? 'call', steps: a.steps ?? 1 });
    return { summary: `${diff.label}; ${diffSummary(diff)}`, diff };
  },

  async export_xer(ctx: ToolCtx, a: { name?: string }): Promise<Result> {
    const doc = ctx.doc();
    const r = await ctx.saveExport(doc.exportName(a.name), doc.exportBytes());
    return { summary: `exported ${r.bytes} bytes to ${r.path}`, data: r };
  },
};

export type ToolName = keyof typeof handlers;
export const READ_TOOLS: ToolName[] = ['get_summary', 'search_activities', 'get_activity', 'list_wbs', 'trace_driving', 'check_logic'];

// ---- tool specs (provider-neutral) ---------------------------------------------------------

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Run a handler and wrap its result the way MCP / the Messages API expect (JSON text). */
export async function runTool(ctx: ToolCtx, name: string, args: unknown): Promise<ToolResult> {
  const fn = (handlers as Record<string, (c: ToolCtx, a: unknown) => Promise<Result>>)[name];
  if (!fn) return { content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool ${name}` }) }], isError: true };
  try {
    const r = await fn(ctx, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text', text: JSON.stringify({ error: msg, tool: name }) }], isError: true };
  }
}

export interface ToolSpec { name: ToolName; description: string; shape: z.ZodRawShape; readOnly: boolean }

const LinkShape = { pred: Code, succ: Code, type: RelType.optional(), lag: Duration.optional() };
const ActivityShape = { name: z.string(), wbs: WbsRef, duration: Duration.optional(), code: Code.optional(), type: z.enum(['Task', 'Mile', 'FinMile']).optional(), after: z.object({ code: Code, type: RelType.optional(), lag: Duration.optional() }).optional(), before: z.object({ code: Code, type: RelType.optional(), lag: Duration.optional() }).optional() };

export const TOOL_SPECS: ToolSpec[] = [
  { name: 'get_summary', readOnly: true, description: 'Project overview: name, data date, finish, counts by status/type, WBS tree, calendars, longest path, logic health counts. Call once per conversation.', shape: {} },
  { name: 'search_activities', readOnly: true, description: 'Find activities by text, WBS, status, type, criticality, float or date window. Returns at most `limit` rows (default 50, max 200) with code, name, dates, float.', shape: { ...FilterShape, limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional(), sort: z.enum(['es', 'ef', 'tf', 'code']).optional() } },
  { name: 'get_activity', readOnly: true, description: 'Full detail for one activity including predecessors and successors.', shape: { code: Code } },
  { name: 'list_wbs', readOnly: true, description: 'The WBS tree with activity counts.', shape: {} },
  { name: 'trace_driving', readOnly: true, description: 'Walk the driving (longest) path backwards from an activity (default: the activity that sets the project finish), or forwards from it.', shape: { code: Code.optional(), direction: z.enum(['back', 'forward']).optional(), depth: z.number().int().min(1).max(50).optional() } },
  { name: 'check_logic', readOnly: true, description: 'Schedule health: open starts/ends, negative float, SS-only chains (dangling), negative and long lags, constraints.', shape: { limit: z.number().int().min(1).max(200).optional() } },
  { name: 'add_activity', readOnly: false, description: 'Add an activity to a WBS node, optionally linked after/before existing activities and constrained. Returns the new code and the schedule diff.', shape: { ...ActivityShape, calendar_id: z.number().optional(), constraint: z.object({ type: CstrShort, date: P6Date }).optional() } },
  { name: 'add_activities', readOnly: false, description: 'Add many activities in one call (up to 60). Each may link after/before an existing code, including codes created earlier in the same batch; chain:true links each one FS to the previous. Returns the new codes in order.', shape: { activities: z.array(z.object(ActivityShape)).min(1).max(60), chain: z.boolean().optional() } },
  { name: 'update_activities', readOnly: false, description: 'Change name, code, duration, remaining duration, WBS, calendar, type or constraint on one or many activities (by codes or a filter). constraint: null removes it.', shape: { codes: z.array(Code).optional(), filter: FilterObj.optional(), set: z.object({ name: z.string().optional(), code: Code.optional(), duration: Duration.optional(), remaining: Duration.optional(), wbs: WbsRef.optional(), calendar_id: z.number().optional(), type: z.enum(['Task', 'Mile', 'FinMile']).optional(), constraint: z.object({ type: CstrShort, date: P6Date }).nullable().optional() }) } },
  { name: 'delete_activities', readOnly: false, description: 'Delete activities (and their relationships, assignments, codes).', shape: { codes: z.array(Code).min(1) } },
  { name: 'add_relationships', readOnly: false, description: 'Add one or many relationships. Default FS lag 0.', shape: { links: z.array(z.object(LinkShape)).min(1) } },
  { name: 'update_relationships', readOnly: false, description: 'Change type and/or lag on relationships selected by ids or by match (pred code, succ code, WBS with both ends inside, current type).', shape: { ids: z.array(z.number()).optional(), match: z.object({ pred: Code.optional(), succ: Code.optional(), wbs: WbsRef.optional(), type: RelType.optional(), within_wbs_only: z.boolean().optional() }).optional(), set: z.object({ type: RelType.optional(), lag: Duration.optional() }) } },
  { name: 'delete_relationships', readOnly: false, description: 'Delete relationships by id or by pred/succ pairs.', shape: { ids: z.array(z.number()).optional(), pairs: z.array(z.object({ pred: Code, succ: Code })).optional() } },
  { name: 'shift_activities', readOnly: false, description: 'Move not-started activities later (or earlier where logic allows) by a signed duration, via start-on-or-after constraints at current early start + shift. Select by codes, a WBS, or a filter.', shape: { codes: z.array(Code).optional(), wbs: WbsRef.optional(), filter: FilterObj.optional(), by: Duration.describe('signed, e.g. {days: 10} or {days: -5}') } },
  { name: 'add_wbs', readOnly: false, description: 'Add a WBS node under a parent.', shape: { name: z.string(), code: z.string().min(1), parent: WbsRef } },
  { name: 'reschedule', readOnly: false, description: 'Re-run the critical path, optionally with a new data date.', shape: { data_date: P6Date.optional() } },
  { name: 'undo_last', readOnly: false, description: 'Undo the last change (scope call) or every change of the last chat turn (scope turn).', shape: { scope: z.enum(['call', 'turn']).optional(), steps: z.number().int().min(1).max(10).optional() } },
  { name: 'export_xer', readOnly: false, description: 'Write the edited schedule to an XER file (the UI also has an Export button).', shape: { name: z.string().optional() } },
];

/** JSON Schema for each tool, for the Messages API. */
export function toolJsonSchemas(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, input_schema: z.toJSONSchema(z.object(t.shape), { io: 'input' }) as Record<string, unknown> }));
}
