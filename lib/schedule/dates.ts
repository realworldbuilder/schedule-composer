// P6 dates are wall-clock strings 'YYYY-MM-DD HH:MM' with no timezone. We model
// them as UTC milliseconds of the same wall-clock, so arithmetic never crosses DST.

export type Ms = number;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const MS = { HOUR, DAY, MIN: 60_000 } as const;

export function parseP6Date(s: string): Ms | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

const p2 = (n: number) => String(n).padStart(2, '0');

export function fmtP6Date(ms: Ms | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

export function fmtDay(ms: Ms): string {
  return fmtP6Date(ms).slice(0, 10);
}

/** Midnight (wall clock) of the day containing ms. */
export function dayStart(ms: Ms): Ms {
  return Math.floor(ms / DAY) * DAY;
}

/** 0 = Sunday .. 6 = Saturday */
export function dayOfWeek(ms: Ms): number {
  return new Date(ms).getUTCDay();
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
export function excelSerialToMs(n: number): Ms {
  return EXCEL_EPOCH + Math.round(n) * DAY;
}
export function msToExcelSerial(ms: Ms): number {
  return Math.round((dayStart(ms) - EXCEL_EPOCH) / DAY);
}

/** Hours as P6 writes them: integer when whole, else up to 2 decimals. */
export function fmtHours(h: number): string {
  const r = Math.round(h * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

export function nowP6(): string {
  const d = new Date();
  return fmtP6Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()));
}
