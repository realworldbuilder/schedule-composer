// Small helpers shared by the UI: P6 date strings, hours -> days, formatting.
import type { SnapTask, Snapshot } from '../lib/schedule/diff.ts';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** 'YYYY-MM-DD HH:MM' (wall clock) -> ms since epoch as if UTC. NaN for blank. */
export function parseDate(s: string | null | undefined): number {
  if (!s) return NaN;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  const hh = s.length >= 16 ? +s.slice(11, 13) : 0, mm = s.length >= 16 ? +s.slice(14, 16) : 0;
  if (!y || !m || !d) return NaN;
  return Date.UTC(y, m - 1, d, hh, mm);
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '06-Apr-26' style, the P6 short date. */
export function fmtShort(s: string | null | undefined): string {
  if (!s) return '';
  const d = +s.slice(8, 10), m = +s.slice(5, 7), y = s.slice(2, 4);
  if (!d || !m) return s;
  return `${String(d).padStart(2, '0')}-${MON[m - 1]}-${y}`;
}
export function fmtShortMs(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(2)}`;
}
export function fmtDay(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export function monthName(ms: number, long = false): string {
  const d = new Date(ms);
  return long ? `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}
export function dayNum(ms: number): number { return new Date(ms).getUTCDate(); }
export function monthStart(ms: number): number { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
export function nextMonth(ms: number): number { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
export function dayStart(ms: number): number { return Math.floor(ms / DAY) * DAY; }
/** Monday on or before ms (epoch day 0 was a Thursday). */
export function weekStart(ms: number): number { const d = dayStart(ms); const dow = (Math.floor(d / DAY) + 4) % 7; return d - ((dow + 6) % 7) * DAY; }

export function dayHoursOf(snap: Snapshot, t: SnapTask): number {
  const c = snap.calendars.find((x) => x.id === t.cal);
  return c?.dayHours || 8;
}
/** hours -> days with one decimal when not whole. */
export function hoursToDays(h: number | null | undefined, dayHours: number): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return '';
  const d = h / (dayHours || 8);
  return Number.isInteger(d) ? String(d) : d.toFixed(1);
}
export function daysOf(h: number, dayHours = 8): number { return h / (dayHours || 8); }

export function taskStart(t: SnapTask): string { return t.as || t.es; }
export function taskFinish(t: SnapTask): string { return t.ae || t.ef; }

export const TYPE_LABEL: Record<string, string> = { Task: 'Task', Mile: 'Start milestone', FinMile: 'Finish milestone', LOE: 'Level of effort', WBS: 'WBS summary', Rsrc: 'Resource dependent' };
/** Small glyph shown before the activity name for non-task types. */
export const TYPE_GLYPH: Record<string, string> = { Mile: '◆', FinMile: '◆', LOE: '↔', WBS: 'Σ', Rsrc: '◦' };
export const STATUS_LABEL: Record<string, string> = { NotStart: 'Not started', Active: 'Active', Complete: 'Complete' };

export function fmtMoney(usd: number): string { return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`; }
export function fmtMs(ms: number): string { return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`; }
export function fmtBytes(n: number): string { return n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1_048_576).toFixed(1)} MB`; }
export function signedDays(hours: number, dayHours = 8): string { const d = hours / dayHours; const s = Number.isInteger(d) ? String(Math.abs(d)) : Math.abs(d).toFixed(1); return `${d > 0 ? '+' : d < 0 ? '-' : ''}${s}d`; }

/** Format a diff value: P6 date strings become dd-MMM-yy, everything else passes through. */
export function fmtValue(v: string): string {
  return /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(v) ? fmtShort(v) : v;
}
/** Local 'YYYY-MM-DD' for the next Monday after today. */
export function nextMondayISO(from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const add = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + add);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Project code from a name: initials for several words, the uppercased word otherwise. */
export function codeFromName(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length === 1) return words[0]!.toUpperCase().slice(0, 10);
  return words.map((w) => w[0]!).join('').toUpperCase().slice(0, 10);
}
/** Rewrite any P6 date strings inside free text as dd-MMM-yy. */
export function fmtDatesIn(text: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\b/g, (m) => fmtShort(m));
}
