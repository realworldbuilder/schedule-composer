// Build a blank project (root WBS, no activities) from the bundled template XER.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXer } from '../xer/parse.ts';
import { serializeXer } from '../xer/serialize.ts';
import { Schedule } from './model.ts';
import { fmtP6Date, nowP6, parseP6Date } from './dates.ts';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'samples', 'PredecessorCalendar.xer');

export interface BlankOptions { name: string; code?: string; start: string; hoursPerDay?: number; workDays?: number[] }

const p2 = (n: number) => String(n).padStart(2, '0');
function shiftsFor(hours: number): string {
  // Split the day around a 12:00-13:00 lunch: 8h -> 08-12 + 13-17, 10h -> 08-13 + 14-19, 4h -> 08-12.
  if (hours <= 4) return `(0||0(s|08:00|f|${p2(8 + hours)}:00)())`;
  const a = Math.ceil(hours / 2); const b = hours - a;
  const aEnd = 8 + a; const bStart = aEnd + 1; const bEnd = bStart + b;
  return `(0||0(s|08:00|f|${p2(aEnd)}:00)())(0||1(s|${p2(bStart)}:00|f|${p2(Math.min(bEnd, 24))}:00)())`;
}

export function clndrData(hoursPerDay: number, workDays: number[]): string {
  const days: string[] = [];
  for (let d = 0; d < 7; d++) days.push(workDays.includes(d) ? `(0||${d + 1}()(${shiftsFor(hoursPerDay)}))` : `(0||${d + 1}()())`);
  return `(0||CalendarData()((0||DaysOfWeek()(${days.join('')}))(0||Exceptions()())))`;
}

export function codeFrom(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const c = words.length >= 2 ? words.map((w) => w[0]!).join('') : (words[0] ?? 'PROJ').slice(0, 8);
  return c.toUpperCase().slice(0, 12) || 'PROJ';
}

export function blankProject(o: BlankOptions): { file: string; bytes: Uint8Array } {
  const start = parseP6Date(o.start.length <= 10 ? `${o.start} 08:00` : o.start);
  if (start === null) throw new Error(`bad start date ${o.start}`);
  const hours = Math.max(1, Math.min(24, o.hoursPerDay ?? 8));
  const workDays = (o.workDays?.length ? o.workDays : [1, 2, 3, 4, 5]).filter((d) => d >= 0 && d <= 6);
  const code = (o.code?.trim() || codeFrom(o.name)).replace(/\s+/g, '-');
  const s = new Schedule(parseXer(new Uint8Array(readFileSync(TEMPLATE))));
  for (const t of s.tasks()) s.deleteActivity(t.task_id);
  const P = s.project;
  P.set('proj_short_name', code); P.set('task_code_prefix', 'A'); P.set('task_code_base', '1000'); P.set('task_code_step', '10');
  P.setDate('plan_start_date', start); P.setDate('last_recalc_date', start - (start % 86_400_000)); P.set('plan_end_date', ''); P.set('scd_end_date', '');
  P.set('add_date', nowP6()); P.set('last_tasksum_date', ''); P.set('fcst_start_date', ''); P.set('guid', '');
  const C = s.T.CALENDAR; const cal = C.rows[0]!;
  C.set(cal, 'clndr_name', `${workDays.length} Day ${hours}h`); C.set(cal, 'day_hr_cnt', String(hours)); C.set(cal, 'week_hr_cnt', String(hours * workDays.length));
  C.set(cal, 'month_hr_cnt', String(Math.round(hours * workDays.length * 52 / 12))); C.set(cal, 'year_hr_cnt', String(hours * workDays.length * 52));
  C.set(cal, 'last_chng_date', nowP6()); C.set(cal, 'clndr_data', clndrData(hours, workDays));
  const root = s.wbsRoot()!;
  root.set('wbs_short_name', code); root.set('wbs_name', o.name.trim());
  s.xer.header[2] = fmtP6Date(Date.now() - new Date().getTimezoneOffset() * 60_000).slice(0, 10);
  s.touch();
  const file = `${code.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}.xer`;
  return { file, bytes: serializeXer(s.xer) };
}
