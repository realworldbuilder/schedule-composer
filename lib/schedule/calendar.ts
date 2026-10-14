import { dayOfWeek, dayStart, excelSerialToMs, fmtDay, MS, type Ms } from './dates.ts';

/** A work shift within a day, in minutes from midnight, [start, end). */
export interface Shift { start: number; end: number }

export interface WorkCal {
  id: number;
  name: string;
  /** Hours per day as declared on the CALENDAR row (used for day <-> hour conversion). */
  dayHours: number;
  /** Weekly pattern, index 0 = Sunday .. 6 = Saturday. */
  week: Shift[][];
  /** Exceptions keyed by 'YYYY-MM-DD'; an empty array means a non-working day. */
  exceptions: Map<string, Shift[]>;
}

// ---- clndr_data parser --------------------------------------------------------
// Grammar (from real exports):  node := '(' '0||' name '(' attrs ')' '(' node* ')' ')'
// attrs := key '|' value ('|' key '|' value)*   e.g. s|08:00|f|12:00  or  d|43650

export interface ClndrNode { name: string; attrs: Record<string, string>; children: ClndrNode[] }

export function parseClndrTree(data: string): ClndrNode[] {
  let i = 0;
  const s = data;
  function node(): ClndrNode | null {
    if (s[i] !== '(') return null;
    i++; // (
    const bar = s.indexOf('(', i);
    let head = s.slice(i, bar); // e.g. "0||DaysOfWeek"
    i = bar;
    const name = head.includes('||') ? head.slice(head.indexOf('||') + 2) : head;
    // attrs
    i++; // (
    let depth = 1; let j = i;
    while (j < s.length && depth > 0) { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; j++; }
    const attrText = s.slice(i, j - 1);
    i = j;
    const attrs: Record<string, string> = {};
    if (attrText) { const p = attrText.split('|'); for (let k = 0; k + 1 < p.length; k += 2) attrs[p[k]!] = p[k + 1]!; }
    // children
    const children: ClndrNode[] = [];
    if (s[i] === '(') {
      i++;
      while (i < s.length && s[i] === '(') { const c = node(); if (c) children.push(c); }
      if (s[i] === ')') i++;
    }
    if (s[i] === ')') i++;
    return { name, attrs, children };
  }
  const out: ClndrNode[] = [];
  while (i < s.length) { const n = node(); if (!n) break; out.push(n); }
  return out;
}

function hm(v: string): number { const [h, m] = v.split(':'); return (+h!) * 60 + (+(m ?? 0)); }

function shiftsOf(n: ClndrNode): Shift[] {
  const out: Shift[] = [];
  for (const c of n.children) {
    if (c.attrs.s !== undefined && c.attrs.f !== undefined) {
      let end = hm(c.attrs.f);
      if (end === 0) end = 24 * 60; // f|00:00 means midnight
      out.push({ start: hm(c.attrs.s), end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function parseClndrData(data: string): { week: Shift[][] | null; exceptions: Map<string, Shift[]> } {
  const tree = parseClndrTree(data);
  const root = tree.find((n) => n.name === 'CalendarData') ?? tree[0];
  let week: Shift[][] | null = null;
  const exceptions = new Map<string, Shift[]>();
  if (!root) return { week, exceptions };
  for (const sec of root.children) {
    if (sec.name === 'DaysOfWeek') {
      week = [[], [], [], [], [], [], []];
      for (const d of sec.children) {
        const k = +d.name; // 1..7 = Sun..Sat
        if (k >= 1 && k <= 7) week[k - 1] = shiftsOf(d);
      }
    } else if (sec.name === 'Exceptions') {
      for (const e of sec.children) {
        const serial = e.attrs.d; if (!serial) continue;
        exceptions.set(fmtDay(excelSerialToMs(+serial)), shiftsOf(e));
      }
    }
  }
  return { week, exceptions };
}

export const STANDARD_WEEK: Shift[][] = [
  [], ...Array.from({ length: 5 }, () => [{ start: 8 * 60, end: 12 * 60 }, { start: 13 * 60, end: 17 * 60 }]), [],
];

export const CAL_24H: WorkCal = {
  id: -24, name: '24 Hour', dayHours: 24,
  week: Array.from({ length: 7 }, () => [{ start: 0, end: 24 * 60 }]), exceptions: new Map(),
};

export interface CalendarRowLike { clndr_id: number; clndr_name: string; day_hr_cnt: number; base_clndr_id: number | null; clndr_data: string }

/** Build a WorkCal from a CALENDAR row, following base_clndr_id when the row has no week of its own. */
export function buildCal(row: CalendarRowLike, all: Map<number, CalendarRowLike>, depth = 0): WorkCal {
  const parsed = parseClndrData(row.clndr_data);
  let week = parsed.week;
  let exceptions = parsed.exceptions;
  if ((!week || week.every((d) => d.length === 0)) && row.base_clndr_id && depth < 5) {
    const base = all.get(row.base_clndr_id);
    if (base) {
      const b = buildCal(base, all, depth + 1);
      week = b.week;
      exceptions = new Map([...b.exceptions, ...exceptions]);
    }
  }
  if (!week || week.every((d) => d.length === 0)) week = STANDARD_WEEK;
  const dayHours = row.day_hr_cnt > 0 ? row.day_hr_cnt : Math.max(1, Math.round(week.reduce((m, d) => Math.max(m, d.reduce((s, x) => s + (x.end - x.start) / 60, 0)), 0)));
  return { id: row.clndr_id, name: row.clndr_name, dayHours, week, exceptions };
}

// ---- work-time arithmetic ---------------------------------------------------------

export function shiftsOn(cal: WorkCal, dayMs: Ms): Shift[] {
  const d0 = dayStart(dayMs);
  const ex = cal.exceptions.get(fmtDay(d0));
  if (ex !== undefined) return ex;
  return cal.week[dayOfWeek(d0)] ?? [];
}

function minuteOfDay(t: Ms): number { return (t - dayStart(t)) / MS.MIN; }

const MAX_SCAN_DAYS = 400;

export function isWorkTime(cal: WorkCal, t: Ms): boolean {
  const m = minuteOfDay(t);
  return shiftsOn(cal, t).some((s) => m >= s.start && m < s.end);
}

/** t itself if inside a shift, else the start of the next shift. */
export function nextWorkStart(cal: WorkCal, t: Ms): Ms {
  let day = dayStart(t);
  let m = minuteOfDay(t);
  for (let n = 0; n < MAX_SCAN_DAYS; n++) {
    for (const s of shiftsOn(cal, day)) {
      if (m < s.end) return day + Math.max(m, s.start) * MS.MIN;
    }
    day += MS.DAY; m = 0;
  }
  throw new Error(`calendar "${cal.name}" has no work time in the next ${MAX_SCAN_DAYS} days`);
}

/** t itself if inside a shift or exactly at its end, else the end of the previous shift. */
export function prevWorkEnd(cal: WorkCal, t: Ms): Ms {
  let day = dayStart(t);
  let m = minuteOfDay(t);
  for (let n = 0; n < MAX_SCAN_DAYS; n++) {
    const sh = shiftsOn(cal, day);
    for (let k = sh.length - 1; k >= 0; k--) {
      const s = sh[k]!;
      if (m > s.start) return day + Math.min(m, s.end) * MS.MIN;
    }
    day -= MS.DAY; m = 24 * 60;
  }
  throw new Error(`calendar "${cal.name}" has no work time in the previous ${MAX_SCAN_DAYS} days`);
}

/** Add signed work hours to t. Positive moves forward from a (snapped) work start; negative moves back. */
export function addWorkHours(cal: WorkCal, t: Ms, hours: number): Ms {
  if (hours === 0) return t;
  let remaining = Math.abs(hours) * 60; // minutes
  if (hours > 0) {
    let cur = nextWorkStart(cal, t);
    let day = dayStart(cur);
    let m = minuteOfDay(cur);
    for (let n = 0; n < MAX_SCAN_DAYS * 4; n++) {
      for (const s of shiftsOn(cal, day)) {
        if (m >= s.end) continue;
        const from = Math.max(m, s.start);
        const avail = s.end - from;
        if (remaining <= avail + 1e-9) return day + (from + remaining) * MS.MIN;
        remaining -= avail;
      }
      day += MS.DAY; m = 0;
    }
  } else {
    let cur = prevWorkEnd(cal, t);
    let day = dayStart(cur);
    let m = minuteOfDay(cur);
    for (let n = 0; n < MAX_SCAN_DAYS * 4; n++) {
      const sh = shiftsOn(cal, day);
      for (let k = sh.length - 1; k >= 0; k--) {
        const s = sh[k]!;
        if (m <= s.start) continue;
        const to = Math.min(m, s.end);
        const avail = to - s.start;
        if (remaining <= avail + 1e-9) return day + (to - remaining) * MS.MIN;
        remaining -= avail;
      }
      day -= MS.DAY; m = 24 * 60;
    }
  }
  throw new Error(`calendar "${cal.name}" cannot place ${hours}h of work`);
}

/** Signed work hours from a to b (negative when b < a). */
export function workHoursBetween(cal: WorkCal, a: Ms, b: Ms): number {
  if (a === b) return 0;
  if (b < a) return -workHoursBetween(cal, b, a);
  let total = 0;
  let day = dayStart(a);
  const lastDay = dayStart(b);
  for (let n = 0; n < 20000 && day <= lastDay; n++, day += MS.DAY) {
    for (const s of shiftsOn(cal, day)) {
      const from = Math.max(day + s.start * MS.MIN, a);
      const to = Math.min(day + s.end * MS.MIN, b);
      if (to > from) total += (to - from) / MS.HOUR;
    }
  }
  return total;
}

export function hoursToDays(cal: WorkCal, h: number): number { return h / cal.dayHours; }
export function daysToHours(cal: WorkCal, d: number): number { return d * cal.dayHours; }
