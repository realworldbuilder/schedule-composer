// Turns a snapshot into the flat, ordered list of grid rows: WBS header rows (collapsible)
// with their tasks sorted by start underneath. Search filters tasks and hides empty groups.
import type { Snapshot, SnapTask, SnapWbs } from '../lib/schedule/diff.ts';
import { parseDate, taskFinish, taskStart } from './util';

export interface WbsRow { kind: 'wbs'; id: number; wbs: SnapWbs; depth: number; start: number; finish: number; count: number; open: boolean; critical: boolean }
export interface TaskRow { kind: 'task'; id: number; task: SnapTask; depth: number; start: number; finish: number }
export type Row = WbsRow | TaskRow;

interface Entry { t: SnapTask; start: number; finish: number }
interface Summary { start: number; finish: number; count: number; critical: boolean }

export function buildRows(snap: Snapshot, collapsed: Set<number>, search: string): Row[] {
  const ids = new Set(snap.wbs.map((w) => w.id));
  const byParent = new Map<number | null, SnapWbs[]>();
  for (const w of snap.wbs) {
    const p = w.parent !== null && ids.has(w.parent) ? w.parent : null;
    let list = byParent.get(p);
    if (!list) byParent.set(p, (list = []));
    list.push(w);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.seq - b.seq || a.code.localeCompare(b.code));

  const q = search.trim().toLowerCase();
  const match = (t: SnapTask) => !q || t.code.toLowerCase().includes(q) || t.name.toLowerCase().includes(q);
  const byWbs = new Map<number, Entry[]>();
  const orphans: Entry[] = [];
  for (const t of snap.tasks) {
    if (!match(t)) continue;
    const e: Entry = { t, start: parseDate(taskStart(t)), finish: parseDate(taskFinish(t)) };
    if (!ids.has(t.wbs)) { orphans.push(e); continue; }
    let list = byWbs.get(t.wbs);
    if (!list) byWbs.set(t.wbs, (list = []));
    list.push(e);
  }
  const cmp = (a: Entry, b: Entry) => (nz(a.start) - nz(b.start)) || (nz(a.finish) - nz(b.finish)) || a.t.code.localeCompare(b.t.code);
  for (const list of byWbs.values()) list.sort(cmp);
  orphans.sort(cmp);

  const rows: Row[] = [];
  function visit(w: SnapWbs, depth: number, emit: boolean): Summary {
    const at = rows.length;
    const open = q ? true : !collapsed.has(w.id);
    const emitChildren = emit && open;
    if (emit) rows.push(null as unknown as Row);   // placeholder, filled once the subtree is known
    const sum: Summary = { start: NaN, finish: NaN, count: 0, critical: false };
    const tasks = byWbs.get(w.id) ?? [];
    for (const e of tasks) {
      sum.count++;
      sum.start = minNaN(sum.start, e.start); sum.finish = maxNaN(sum.finish, e.finish);
      if (e.t.critical && e.t.status !== 'Complete') sum.critical = true;
      if (emitChildren) rows.push({ kind: 'task', id: e.t.id, task: e.t, depth: depth + 1, start: e.start, finish: e.finish });
    }
    for (const c of byParent.get(w.id) ?? []) {
      const cs = visit(c, depth + 1, emitChildren);
      sum.count += cs.count;
      sum.start = minNaN(sum.start, cs.start); sum.finish = maxNaN(sum.finish, cs.finish);
      if (cs.critical) sum.critical = true;
    }
    if (emit) {
      if (q && sum.count === 0) rows.length = at;   // nothing matched below here
      else rows[at] = { kind: 'wbs', id: w.id, wbs: w, depth, start: sum.start, finish: sum.finish, count: sum.count, open, critical: sum.critical };
    }
    return sum;
  }
  for (const w of byParent.get(null) ?? []) visit(w, 0, true);
  for (const e of orphans) rows.push({ kind: 'task', id: e.t.id, task: e.t, depth: 0, start: e.start, finish: e.finish });
  return rows;
}

const nz = (n: number) => (Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER);
const minNaN = (a: number, b: number) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.min(a, b));
const maxNaN = (a: number, b: number) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b));
