// Gantt drawing: the sticky time-scale header and the bar layer for the visible window of
// rows. Plain SVG; the grid in Schedule.tsx owns scrolling and virtualisation.
import type { JSX } from 'preact';
import type { SnapRel, SnapTask } from '../../lib/schedule/diff.ts';
import type { Row } from '../rows';
import { DAY, dayNum, dayStart, monthName, monthStart, nextMonth, parseDate, weekStart } from '../util';

export const ROW_H = 24;
export const HEAD_H = 40;

/** Linear time scale: x = (ms - t0) / DAY * ppd. */
export interface Scale { t0: number; t1: number; ppd: number; width: number }
export const xOf = (sc: Scale, ms: number): number => ((ms - sc.t0) / DAY) * sc.ppd;
export const msAt = (sc: Scale, x: number): number => sc.t0 + (x / sc.ppd) * DAY;

export type ZoomMode = 'day' | 'week' | 'month';
export const ZOOM_PPD: Record<ZoomMode, number> = { day: 22, week: 5, month: 1.6 };
export function tierOf(ppd: number): ZoomMode { return ppd >= 12 ? 'day' : ppd >= 2.5 ? 'week' : 'month'; }

// ---- time scale ------------------------------------------------------------------

export function TimeScale({ sc, dataDate }: { sc: Scale; dataDate: number }) {
  const tier = tierOf(sc.ppd);
  const top: JSX.Element[] = [];
  const bottom: JSX.Element[] = [];
  const shade: JSX.Element[] = [];
  const H1 = 20;

  if (tier === 'month') {
    // years on top, months below
    for (let y = new Date(sc.t0).getUTCFullYear(); ; y++) {
      const a = Math.max(sc.t0, Date.UTC(y, 0, 1)), b = Math.min(sc.t1, Date.UTC(y + 1, 0, 1));
      if (a >= sc.t1) break;
      const x = xOf(sc, a), w = xOf(sc, b) - x;
      top.push(<g key={y}><line x1={x} x2={x} y1={0} y2={H1} class="ts-line" />{w > 30 && <text x={x + 4} y={14} class="ts-text">{y}</text>}</g>);
    }
    for (let m = monthStart(sc.t0); m < sc.t1; m = nextMonth(m)) {
      const x = xOf(sc, m), w = xOf(sc, nextMonth(m)) - x;
      const lab = monthName(m).slice(0, 3);
      bottom.push(<g key={m}><line x1={x} x2={x} y1={H1} y2={HEAD_H} class="ts-line" />{w > 14 && <text x={x + w / 2} y={34} class="ts-text small" text-anchor="middle">{w > 26 ? lab : lab[0]}</text>}</g>);
    }
  } else {
    for (let m = monthStart(sc.t0); m < sc.t1; m = nextMonth(m)) {
      const x = Math.max(0, xOf(sc, m)), w = xOf(sc, nextMonth(m)) - x;
      top.push(<g key={m}><line x1={x} x2={x} y1={0} y2={H1} class="ts-line" />{w > 40 && <text x={x + 4} y={14} class="ts-text">{monthName(m, w > 70)}</text>}</g>);
    }
    if (tier === 'week') {
      for (let d = weekStart(sc.t0); d < sc.t1; d += 7 * DAY) {
        const x = xOf(sc, d);
        if (x < 0) continue;
        bottom.push(<g key={d}><line x1={x} x2={x} y1={H1} y2={HEAD_H} class="ts-line" />{7 * sc.ppd > 16 && <text x={x + 3} y={34} class="ts-text small">{dayNum(d)}</text>}</g>);
      }
    } else {
      for (let d = dayStart(sc.t0); d < sc.t1; d += DAY) {
        const x = xOf(sc, d);
        const dow = (Math.floor(d / DAY) + 4) % 7;   // 0 = Sunday
        if (dow === 0 || dow === 6) shade.push(<rect key={`s${d}`} x={x} y={H1} width={sc.ppd} height={HEAD_H - H1} class="ts-weekend" />);
        bottom.push(<g key={d}><line x1={x} x2={x} y1={H1} y2={HEAD_H} class="ts-line faint" />{(sc.ppd >= 18 || dow === 1) && <text x={sc.ppd >= 18 ? x + sc.ppd / 2 : x + 2} y={34} class="ts-text small" text-anchor={sc.ppd >= 18 ? 'middle' : 'start'}>{dayNum(d)}</text>}</g>);
      }
    }
  }
  const dd = xOf(sc, dataDate);
  return (
    <svg class="timescale" width={sc.width} height={HEAD_H}>
      {shade}
      <line x1={0} x2={sc.width} y1={H1} y2={H1} class="ts-line" />
      {top}{bottom}
      {Number.isFinite(dd) && <><line x1={dd} x2={dd} y1={0} y2={HEAD_H} class="dd-line" /><path d={`M${dd - 4},${HEAD_H - 6} L${dd + 4},${HEAD_H - 6} L${dd},${HEAD_H} Z`} class="dd-mark" /></>}
    </svg>
  );
}

// ---- bars ---------------------------------------------------------------------------

export interface Related { preds: Set<number>; succs: Set<number> }

interface BodyProps {
  sc: Scale;
  rows: Row[];
  first: number;         // index of the first row drawn
  last: number;          // one past the last row drawn
  dataDate: number;
  selected: number | null;
  selRels: SnapRel[];    // relationships touching the selected task
  rowOf: Map<number, number>;   // task id -> row index (visible rows only)
  taskById: (id: number) => SnapTask | undefined;
  showLate: boolean;
}

export function GanttBody({ sc, rows, first, last, dataDate, selected, selRels, rowOf, taskById, showLate }: BodyProps) {
  const h = (last - first) * ROW_H;
  const bars: JSX.Element[] = [];
  const gridLines: JSX.Element[] = [];
  // vertical grid: month boundaries only
  for (let m = monthStart(sc.t0); m < sc.t1; m = nextMonth(m)) { const x = Math.round(xOf(sc, m)) + 0.5; gridLines.push(<line key={`m${m}`} x1={x} x2={x} y1={0} y2={h} class="grid-line" />); }

  for (let i = first; i < last; i++) {
    const r = rows[i]!;
    const y = (i - first) * ROW_H;
    if (r.kind === 'wbs') {
      if (!Number.isFinite(r.start) || !Number.isFinite(r.finish)) continue;
      const x1 = xOf(sc, r.start), x2 = Math.max(x1 + 2, xOf(sc, r.finish));
      // quiet summary bracket: a thin line with short end ticks
      bars.push(
        <path key={`w${r.id}`} class="sum-bar"
          d={`M${x1},${y + 15} V${y + 10} H${x2} V${y + 15}`} />,
      );
      continue;
    }
    bars.push(<TaskBar key={r.id} sc={sc} t={r.task} y={y} selected={selected === r.id} dataDate={dataDate} showLate={showLate} />);
  }

  // relationship arrows for the selected task
  const arrows: JSX.Element[] = [];
  if (selected !== null) {
    for (const rel of selRels) {
      const pi = rowOf.get(rel.pred), si = rowOf.get(rel.succ);
      if (pi === undefined || si === undefined) continue;
      const p = taskById(rel.pred), s = taskById(rel.succ);
      if (!p || !s) continue;
      const fromEnd = rel.type === 'FS' || rel.type === 'FF';
      const toStart = rel.type === 'FS' || rel.type === 'SS';
      const sx = xOf(sc, parseDate(fromEnd ? barEnd(p) : barStart(p)));
      const tx = xOf(sc, parseDate(toStart ? barStart(s) : barEnd(s)));
      if (!Number.isFinite(sx) || !Number.isFinite(tx)) continue;
      const y1 = (pi - first) * ROW_H + ROW_H / 2, y2 = (si - first) * ROW_H + ROW_H / 2;
      const d = elbow(sx + (isMile(p) && fromEnd ? 5 : 0) - (isMile(p) && !fromEnd ? 5 : 0), y1, fromEnd ? 1 : -1,
        tx - (isMile(s) && toStart ? 5 : 0) + (isMile(s) && !toStart ? 5 : 0), y2, toStart ? 1 : -1);
      const kind = rel.pred === selected ? 'succ' : 'pred';
      arrows.push(<path key={rel.id} d={d} class={`arrow ${kind} ${rel.driving ? 'driving' : ''}`} marker-end={`url(#ah-${rel.driving ? 'drv' : kind})`} />);
    }
  }

  const dd = xOf(sc, dataDate);
  return (
    <svg class="gantt" width={sc.width} height={h} style={{ top: `${first * ROW_H}px` }}>
      <defs>
        <marker id="ah-pred" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 Z" class="ah pred" /></marker>
        <marker id="ah-succ" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 Z" class="ah succ" /></marker>
        <marker id="ah-drv" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 Z" class="ah drv" /></marker>
      </defs>
      {gridLines}
      {Number.isFinite(dd) && <line x1={dd} x2={dd} y1={0} y2={h} class="dd-line" />}
      {bars}
      {arrows}
    </svg>
  );
}

const isMile = (t: SnapTask) => t.type === 'Mile' || t.type === 'FinMile';
const barStart = (t: SnapTask) => t.as || t.es;
const barEnd = (t: SnapTask) => t.ae || t.ef;

/** Orthogonal connector: leave the source horizontally in direction dOut, enter the target in direction dIn. */
function elbow(sx: number, y1: number, dOut: number, tx: number, y2: number, dIn: number): string {
  const G = 8;
  const ax = sx + dOut * G;          // first bend x
  const bx = tx - dIn * G;           // last bend x
  if (dOut === dIn ? (bx - ax) * dIn >= 0 : true) {
    // one vertical run
    const vx = dOut === dIn ? ax : dOut < 0 ? Math.min(ax, bx) : Math.max(ax, bx);
    return `M${sx},${y1} H${vx} V${y2} H${tx}`;
  }
  const ym = y2 + (y2 > y1 ? -ROW_H / 2 : ROW_H / 2);
  return `M${sx},${y1} H${ax} V${ym} H${bx} V${y2} H${tx}`;
}

function TaskBar({ sc, t, y, selected, dataDate, showLate }: { sc: Scale; t: SnapTask; y: number; selected: boolean; dataDate: number; showLate: boolean }) {
  const s = parseDate(barStart(t)), f = parseDate(barEnd(t));
  const done = t.status === 'Complete';
  const crit = t.critical && !done;
  const tone = done ? 'done' : crit ? 'crit' : 'norm';
  const late: JSX.Element | null = (() => {
    if (done || !showLate) return null;
    const ls = parseDate(t.ls), lf = parseDate(t.lf);
    if (!Number.isFinite(ls) || !Number.isFinite(lf) || isMile(t)) return null;
    const lx = xOf(sc, ls);
    return <rect x={lx} y={y + 19} width={Math.max(1, xOf(sc, lf) - lx)} height={1.5} class="late-bar" />;
  })();

  if (isMile(t)) {
    const at = t.type === 'Mile' ? s : f;
    if (!Number.isFinite(at)) return null;
    const x = xOf(sc, at), cy = y + ROW_H / 2, r = 5.5;
    return (
      <g>
        <path d={`M${x},${cy - r} L${x + r},${cy} L${x},${cy + r} L${x - r},${cy} Z`} class={`ms ${tone} ${t.driving ? 'driving' : ''} ${selected ? 'sel' : ''}`} />
      </g>
    );
  }
  if (!Number.isFinite(s) || !Number.isFinite(f)) return null;
  const x = xOf(sc, s), w = Math.max(2, xOf(sc, f) - x);
  const by = y + 6, bh = 12;
  let progress: JSX.Element | null = null;
  if (t.status === 'Active') {
    // completed portion: physical % complete, never past the data date
    let px = w * Math.max(0, Math.min(100, t.pct)) / 100;
    if (!px && Number.isFinite(dataDate)) px = Math.max(0, Math.min(w, xOf(sc, dataDate) - x));
    if (px > 0) progress = <rect x={x} y={by} width={Math.min(w, px)} height={bh} rx={2} class={`bar-prog ${crit ? 'crit' : ''}`} />;
  }
  return (
    <g>
      {late}
      <rect x={x} y={by} width={w} height={bh} rx={2} class={`bar ${tone}`} />
      {progress}
      {(selected || (t.driving && !done)) && <rect x={x - 0.5} y={by - 0.5} width={w + 1} height={bh + 1} rx={2.5} class={`bar-ring ${selected ? 'sel' : 'driving'}`} />}
    </g>
  );
}
