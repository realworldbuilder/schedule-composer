import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseXer } from '../lib/xer/parse.ts';
import { buildCal, parseClndrData, addWorkHours, workHoursBetween, nextWorkStart, prevWorkEnd, isWorkTime, CAL_24H, type CalendarRowLike } from '../lib/schedule/calendar.ts';
import { parseP6Date as d, fmtP6Date, excelSerialToMs, fmtDay } from '../lib/schedule/dates.ts';

function sampleCal(): ReturnType<typeof buildCal> {
  const f = parseXer(new Uint8Array(readFileSync('samples/PredecessorCalendar.xer')));
  const t = f.tables.find((x) => x.name === 'CALENDAR')!;
  const g = (r: string[], k: string) => r[t.fields.indexOf(k)] ?? '';
  const rows: CalendarRowLike[] = t.rows.map((r) => ({ clndr_id: +g(r, 'clndr_id'), clndr_name: g(r, 'clndr_name'), day_hr_cnt: +g(r, 'day_hr_cnt'), base_clndr_id: g(r, 'base_clndr_id') ? +g(r, 'base_clndr_id') : null, clndr_data: g(r, 'clndr_data') }));
  return buildCal(rows[0]!, new Map(rows.map((r) => [r.clndr_id, r])));
}

describe('calendar', () => {
  const cal = sampleCal();
  const D = (s: string) => d(s)!;

  it('parses the weekly pattern and exceptions', () => {
    expect(cal.dayHours).toBe(8);
    expect(cal.week[0]).toEqual([]);
    expect(cal.week[1]).toEqual([{ start: 480, end: 720 }, { start: 780, end: 1020 }]);
    expect(cal.week[6]).toEqual([]);
    expect(fmtDay(excelSerialToMs(43650))).toBe('2019-07-04');
    expect(cal.exceptions.get('2019-07-04')).toEqual([]);
    expect(isWorkTime(cal, D('2019-07-04 10:00'))).toBe(false);
  });

  it('measures the sample task as 24h', () => {
    expect(workHoursBetween(cal, D('2019-06-10 08:00'), D('2019-06-12 17:00'))).toBe(24);
    expect(workHoursBetween(cal, D('2019-06-12 17:00'), D('2019-06-10 08:00'))).toBe(-24);
  });

  it('snaps to work time', () => {
    expect(fmtP6Date(nextWorkStart(cal, D('2019-10-02 00:00')))).toBe('2019-10-02 08:00');
    expect(fmtP6Date(nextWorkStart(cal, D('2019-10-02 12:30')))).toBe('2019-10-02 13:00');
    expect(fmtP6Date(nextWorkStart(cal, D('2019-10-05 09:00')))).toBe('2019-10-07 08:00'); // Saturday
    expect(fmtP6Date(prevWorkEnd(cal, D('2019-10-07 07:00')))).toBe('2019-10-04 17:00');
    expect(fmtP6Date(prevWorkEnd(cal, D('2019-10-07 17:00')))).toBe('2019-10-07 17:00');
  });

  it('adds work hours across the July 4 exception and a weekend', () => {
    expect(fmtP6Date(addWorkHours(cal, D('2019-07-03 08:00'), 16))).toBe('2019-07-08 17:00');
    expect(fmtP6Date(addWorkHours(cal, D('2019-07-08 17:00'), -16))).toBe('2019-07-03 08:00');
    expect(fmtP6Date(addWorkHours(cal, D('2019-10-02 08:00'), 80))).toBe('2019-10-15 17:00');
    expect(fmtP6Date(addWorkHours(cal, D('2019-10-02 08:00'), 2))).toBe('2019-10-02 10:00');
    expect(fmtP6Date(addWorkHours(cal, D('2019-10-02 08:00'), 4))).toBe('2019-10-02 12:00');
    expect(fmtP6Date(addWorkHours(cal, D('2019-10-02 08:00'), 5))).toBe('2019-10-02 14:00');
    expect(fmtP6Date(addWorkHours(cal, D('2019-10-02 17:00'), 8))).toBe('2019-10-03 17:00');
  });

  it('24h calendar is plain arithmetic', () => {
    expect(fmtP6Date(addWorkHours(CAL_24H, D('2019-10-02 00:00'), 30))).toBe('2019-10-03 06:00');
    expect(workHoursBetween(CAL_24H, D('2019-10-02 00:00'), D('2019-10-03 06:00'))).toBe(30);
  });

  it('falls back to the standard week when a calendar has no pattern', () => {
    const p = parseClndrData('(0||CalendarData()((0||DaysOfWeek()())(0||Exceptions()())))');
    expect(p.week!.every((x) => x.length === 0)).toBe(true);
    const c = buildCal({ clndr_id: 1, clndr_name: 'x', day_hr_cnt: 0, base_clndr_id: null, clndr_data: '' }, new Map());
    expect(c.week[1]!.length).toBe(2);
    expect(c.dayHours).toBe(8);
  });
});
