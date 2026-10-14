// Activity table + Gantt in one scroll container: the header sticks to the top, the table
// columns stick to the left, the bars scroll under them. Rows are virtualised (viewport
// ± a buffer) so a 5,000-activity file scrolls as smoothly as a 200-activity one.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { SnapRel, SnapTask, Snapshot } from '../../lib/schedule/diff.ts';
import { buildRows, type TaskRow, type WbsRow } from '../rows';
import { useApp, select, toggleWbs, setAllCollapsed, setSearch, setDetailsOpen, setShowLate, prefillChat, HL_MS, type App, type Highlight } from '../store';
import { Welcome } from './NewProject';
import { DAY, STATUS_LABEL, TYPE_GLYPH, TYPE_LABEL, dayHoursOf, fmtShort, fmtShortMs, hoursToDays, monthStart, nextMonth, parseDate, taskFinish, taskStart } from '../util';
import { GanttBody, HEAD_H, ROW_H, TimeScale, ZOOM_PPD, msAt, tierOf, xOf, type Scale, type ZoomMode } from './Gantt';

const BUFFER = 12;
const COLS = { code: 76, dur: 44, start: 88, finish: 88, tf: 40, status: 104 };
const FIXED_W = Object.values(COLS).reduce((a, b) => a + b, 0);

const loadNum = (k: string, d: number) => { try { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : d; } catch { return d; } };
const saveNum = (k: string, v: number) => { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } };

export function Schedule() {
  const s = useApp();
  const snap = s.snapshot;
  if (!snap) {
    if (s.noFile) return <div class="sched empty"><Welcome /></div>;
    return (
      <div class="sched empty">
        <div class="empty-msg">{s.offline ? 'Cannot reach the server on port 4400. Retrying…' : 'Loading schedule…'}</div>
      </div>
    );
  }
  return <Grid s={s} snap={snap} />;
}

function Grid({ s, snap }: { s: App; snap: Snapshot }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, h: 600, w: 1000 });
  const [nameW, setNameW] = useState(() => loadNum('sc.nameW', 260));
  const [ppd, setPpd] = useState(ZOOM_PPD.week);
  const [hover, setHover] = useState<{ id: number; x: number; y: number } | null>(null);
  const pendingLeft = useRef<number | null>(null);
  const tableW = FIXED_W + nameW;

  const rows = useMemo(() => buildRows(snap, s.collapsed, s.search), [snap, s.collapsed, s.search]);
  const rowOf = useMemo(() => { const m = new Map<number, number>(); rows.forEach((r, i) => { if (r.kind === 'task') m.set(r.id, i); }); return m; }, [rows]);
  const relsByTask = useMemo(() => {
    const m = new Map<number, SnapRel[]>();
    const add = (id: number, r: SnapRel) => { let l = m.get(id); if (!l) m.set(id, (l = [])); l.push(r); };
    for (const r of snap.rels) { add(r.pred, r); add(r.succ, r); }
    return m;
  }, [snap.rels]);
  const taskById = (id: number): SnapTask | undefined => { const i = s.taskIndex.get(id); return i === undefined ? undefined : snap.tasks[i]; };
  const matchCount = useMemo(() => rows.reduce((n, r) => n + (r.kind === 'task' ? 1 : 0), 0), [rows]);

  // Time range: whole months around every bar and the data date. Stable across small edits.
  const dataDate = parseDate(snap.project.dataDate);
  const range = useMemo(() => {
    let lo = dataDate, hi = dataDate;
    for (const t of snap.tasks) {
      const a = parseDate(taskStart(t)), b = parseDate(taskFinish(t)), lf = parseDate(t.lf);
      if (a < lo || !Number.isFinite(lo)) lo = a;
      if (b > hi || !Number.isFinite(hi)) hi = b;
      if (lf > hi) hi = lf;
    }
    if (!Number.isFinite(lo)) lo = Date.now();
    if (!Number.isFinite(hi) || hi <= lo) hi = lo + 90 * DAY;
    return { t0: monthStart(lo - 7 * DAY), t1: nextMonth(hi + 14 * DAY) };
  }, [snap.tasks, dataDate]);
  const sc: Scale = { t0: range.t0, t1: range.t1, ppd, width: Math.ceil(((range.t1 - range.t0) / DAY) * ppd) };
  const totalW = tableW + sc.width;
  const ganttViewW = Math.max(200, view.w - tableW);

  // Measure the viewport.
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    const measure = () => setView((v) => ({ ...v, h: el.clientHeight, w: el.clientWidth, top: el.scrollTop, left: el.scrollLeft }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-fit the project range when a schedule is (re)loaded. While the view is "fitted"
  // (no manual zoom since), refit whenever the range changes, so a new project that the
  // agent is filling in keeps the whole schedule on screen.
  const fittedFor = useRef(-1);
  const autoFit = useRef(true);
  const fit = () => {
    const days = (range.t1 - range.t0) / DAY;
    const w = Math.max(200, (scroller.current?.clientWidth ?? view.w) - tableW - 8);
    setPpd(Math.max(0.3, Math.min(40, w / days)));
    pendingLeft.current = 0;
    autoFit.current = true;
  };
  useLayoutEffect(() => { if (fittedFor.current !== s.loadSeq && view.w > 0) { fittedFor.current = s.loadSeq; fit(); } }, [s.loadSeq, view.w > 0]);
  const hasTasks = snap.tasks.length > 0;
  const wasEmpty = useRef(!hasTasks);
  useLayoutEffect(() => {
    if (view.w <= 0) return;
    if ((wasEmpty.current && hasTasks) || autoFit.current) fit();
    wasEmpty.current = !hasTasks;
  }, [range.t0, range.t1, hasTasks]);

  // Keep the date at the centre of the Gantt when zooming.
  const zoomTo = (next: number) => {
    autoFit.current = false;
    const el = scroller.current;
    if (el) { const centre = msAt(sc, el.scrollLeft + ganttViewW / 2); pendingLeft.current = Math.max(0, ((centre - sc.t0) / DAY) * next - ganttViewW / 2); }
    setPpd(next);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pendingLeft.current !== null) { el.scrollLeft = pendingLeft.current; pendingLeft.current = null; }
  }, [ppd]);

  // Scroll a task into view when something asks (chat card click, search, keyboard).
  useEffect(() => {
    const req = s.scrollTo; const el = scroller.current;
    if (!req || !el) return;
    const i = rows.findIndex((r) => r.kind === 'task' && r.id === req.id);
    if (i < 0) return;
    const y = i * ROW_H, bodyH = el.clientHeight - HEAD_H;
    if (y < el.scrollTop || y + ROW_H > el.scrollTop + bodyH) el.scrollTop = Math.max(0, y - bodyH / 3);
    const r = rows[i] as TaskRow;
    if (Number.isFinite(r.start)) {
      const x = xOf(sc, r.start);
      if (x < el.scrollLeft || x > el.scrollLeft + ganttViewW - 40) el.scrollLeft = Math.max(0, x - 60);
    }
  }, [s.scrollTo?.seq, rows]);

  const onScroll = () => {
    const el = scroller.current; if (!el) return;
    setView((v) => (v.top === el.scrollTop && v.left === el.scrollLeft ? v : { ...v, top: el.scrollTop, left: el.scrollLeft }));
    if (hover) setHover(null);
  };

  // Keyboard: up/down moves the selection, Esc clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (e.key === 'Escape' && s.selected !== null) { select(null); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const cur = s.selected === null ? -1 : rowOf.get(s.selected) ?? -1;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      for (let i = cur + dir; i >= 0 && i < rows.length; i += dir) {
        if (rows[i]!.kind === 'task') { e.preventDefault(); select(rows[i]!.id, { scroll: true }); return; }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, rowOf, s.selected]);

  // Name column resize.
  const startResize = (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = nameW;
    let w = w0;
    const move = (ev: MouseEvent) => { w = Math.max(120, Math.min(600, w0 + ev.clientX - x0)); setNameW(w); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('dragging'); saveNum('sc.nameW', w); };
    document.body.classList.add('dragging');
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  // Virtual window.
  const bodyH = Math.max(0, view.h - HEAD_H);
  const first = Math.max(0, Math.floor(view.top / ROW_H) - BUFFER);
  const last = Math.min(rows.length, Math.ceil((view.top + bodyH) / ROW_H) + BUFFER);

  const sel = s.selected !== null ? taskById(s.selected) : undefined;
  const selRels = sel ? relsByTask.get(sel.id) ?? [] : [];
  const preds = new Set<number>(), succs = new Set<number>();
  for (const r of selRels) { if (r.succ === sel!.id) preds.add(r.pred); else succs.add(r.succ); }
  const now = Date.now();
  const tier = tierOf(ppd);

  const onHover = (id: number, cx: number, cy: number) => {
    const el = scroller.current;
    if (id < 0 || !el || cx - el.getBoundingClientRect().left < tableW) { if (hover) setHover(null); return; }
    setHover({ id, x: cx, y: cy });
  };

  const visible: JSX.Element[] = [];
  for (let i = first; i < last; i++) {
    const r = rows[i]!;
    visible.push(r.kind === 'wbs'
      ? <WbsLine key={`w${r.id}`} r={r} i={i} width={totalW} tableW={tableW} nameW={nameW} hl={s.wbsHighlights.get(r.id)} now={now} />
      : <TaskLine key={r.id} r={r} i={i} snap={snap} width={totalW} tableW={tableW} nameW={nameW}
          selected={s.selectedSet.has(r.id)} primary={s.selected === r.id}
          rel={preds.has(r.id) ? 'pred' : succs.has(r.id) ? 'succ' : ''}
          hl={s.highlights.get(r.id)} now={now}
          onHover={onHover} />);
  }

  return (
    <div class="sched">
      <div class="sched-bar">
        <div class="search">
          <svg viewBox="0 0 16 16" class="ico"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" /></svg>
          <input type="search" placeholder="Filter by code or name" value={s.search} onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setSearch(''); if (e.key === 'Enter') { const r = rows.find((x) => x.kind === 'task'); if (r) select(r.id, { scroll: true }); } }} />
          {s.search && <span class="count">{matchCount}</span>}
        </div>
        <span class="grow" />
        <div class="seg" role="group" aria-label="Zoom">
          {(['day', 'week', 'month'] as ZoomMode[]).map((z) => (
            <button key={z} class={!autoFit.current && tier === z && Math.abs(ppd - ZOOM_PPD[z]) < 0.01 ? 'on' : ''} onClick={() => zoomTo(ZOOM_PPD[z])}>{z[0]!.toUpperCase() + z.slice(1)}</button>
          ))}
          <button class={autoFit.current ? 'on' : ''} title="Fit the whole project" onClick={fit}>Fit</button>
        </div>
        <div class="seg" role="group" aria-label="WBS groups">
          <button title="Expand every WBS" onClick={() => setAllCollapsed(false)}>Expand</button>
          <button title="Collapse to the top-level WBS" onClick={() => setAllCollapsed(true)}>Collapse</button>
        </div>
        <Help showLate={s.showLate} />
      </div>
      <div class="grid" ref={scroller} onScroll={onScroll}>
        <div class="sheet" style={{ width: `${totalW}px`, height: `${HEAD_H + rows.length * ROW_H}px` }}>
          <div class="ghead" style={{ width: `${totalW}px` }}>
            <div class="thead" style={{ width: `${tableW}px` }}>
              <span class="c code" style={{ width: `${COLS.code}px` }}>Code</span>
              <span class="c name" style={{ width: `${nameW}px` }}>Name<span class="resize" onMouseDown={startResize} title="Drag to resize" /></span>
              <span class="c num" style={{ width: `${COLS.dur}px` }} title="Original duration, days">Dur</span>
              <span class="c date" style={{ width: `${COLS.start}px` }}>Start</span>
              <span class="c date" style={{ width: `${COLS.finish}px` }}>Finish</span>
              <span class="c num" style={{ width: `${COLS.tf}px` }} title="Total float, days">TF</span>
              <span class="c status" style={{ width: `${COLS.status}px` }}>Status</span>
            </div>
            <TimeScale sc={sc} dataDate={dataDate} />
          </div>
          <div class="gbody" style={{ height: `${rows.length * ROW_H}px` }}>
            {visible}
            <div class="gantt-wrap" style={{ left: `${tableW}px` }}>
              <GanttBody sc={sc} rows={rows} first={first} last={last} dataDate={dataDate}
                selected={s.selected} selRels={selRels} rowOf={rowOf} taskById={taskById} showLate={s.showLate} />
            </div>
          </div>
          {s.search && rows.length === 0 && <div class="no-rows" style={{ width: `${tableW}px` }}>No activity matches “{s.search}”.</div>}
        </div>
        {!hasTasks && !s.search && <EmptySchedule />}
      </div>
      {hover && (() => { const t = taskById(hover.id); return t ? <Tip t={t} snap={snap} x={hover.x} y={hover.y} /> : null; })()}
      {sel && s.detailsOpen && <Details t={sel} snap={snap} rels={selRels} taskById={taskById} />}
      {sel && !s.detailsOpen && <button class="details-tab" onClick={() => setDetailsOpen(true)}>Details · {sel.code}</button>}
    </div>
  );
}

// ---- rows -------------------------------------------------------------------------------

interface LineProps { i: number; width: number; tableW: number; nameW: number }

function WbsLine({ r, i, width, tableW, nameW, hl, now }: LineProps & { r: WbsRow; hl: number | undefined; now: number }) {
  const age = hl !== undefined ? now - hl : Infinity;
  return (
    <div class={`row wbs d${Math.min(r.depth, 4)} ${i === 0 ? 'first' : ''}`} style={{ top: `${i * ROW_H}px`, width: `${width}px` }} onClick={() => toggleWbs(r.id)}>
      {age < HL_MS.edit && <div key={hl} class="hl edit" style={{ animationDelay: `-${age}ms` }} />}
      <div class="cells" style={{ width: `${tableW}px` }}>
        <span class="c wbs-title" style={{ width: `${COLS.code + nameW}px`, paddingLeft: `${8 + r.depth * 12}px` }}>
          <span class={`caret ${r.open ? 'open' : ''}`}>▸</span>
          <span class="wname" title={`${r.wbs.code} · ${r.wbs.name}`}>{r.wbs.name}</span>
          <span class="wcount">{r.count || ''}</span>
        </span>
        <span class="c" style={{ width: `${COLS.dur}px` }} />
        <span class="c date mono" style={{ width: `${COLS.start}px` }}>{fmtShortMs(r.start)}</span>
        <span class="c date mono" style={{ width: `${COLS.finish}px` }}>{fmtShortMs(r.finish)}</span>
        <span class="c" style={{ width: `${COLS.tf + COLS.status}px` }} />
      </div>
    </div>
  );
}

interface TaskLineProps extends LineProps { r: TaskRow; snap: Snapshot; selected: boolean; primary: boolean; rel: '' | 'pred' | 'succ'; hl: Highlight | undefined; now: number; onHover: (id: number, x: number, y: number) => void }

function TaskLine({ r, i, snap, width, tableW, nameW, selected, primary, rel, hl, now, onHover }: TaskLineProps) {
  const t = r.task;
  const dh = dayHoursOf(snap, t);
  const tfDays = t.tf === null ? null : t.tf / dh;
  const crit = t.critical && t.status !== 'Complete';
  const age = hl !== undefined ? now - hl.at : Infinity;
  const glyph = TYPE_GLYPH[t.type];
  return (
    <div
      class={`row task ${selected ? 'sel' : ''} ${primary ? 'primary' : ''} ${rel ? `rel-${rel}` : ''} ${crit ? 'crit' : ''} ${t.status === 'Complete' ? 'done' : ''}`}
      style={{ top: `${i * ROW_H}px`, width: `${width}px` }}
      onClick={(e) => select(t.id, { add: e.metaKey || e.ctrlKey, scroll: !(e.metaKey || e.ctrlKey) })}
      onMouseMove={(e) => onHover(t.id, e.clientX, e.clientY)}
      onMouseLeave={() => onHover(-1, 0, 0)}
    >
      {hl && age < HL_MS[hl.kind] && <div key={hl.at} class={`hl ${hl.kind}`} style={{ animationDelay: `-${age}ms` }} />}
      <div class="cells" style={{ width: `${tableW}px` }}>
        <span class="c code mono" style={{ width: `${COLS.code}px` }}>{t.code}</span>
        <span class="c name" style={{ width: `${nameW}px`, paddingLeft: `${8 + r.depth * 12}px` }} title={`${t.name}${glyph ? ` (${TYPE_LABEL[t.type]})` : ''}`}>
          {glyph && <span class={`glyph g-${t.type}`}>{glyph}</span>}{t.name}
        </span>
        <span class="c num" style={{ width: `${COLS.dur}px` }}>{hoursToDays(t.dur, dh)}</span>
        <span class={`c date mono ${t.as ? 'actual' : ''}`} style={{ width: `${COLS.start}px` }} title={t.as ? 'Actual start' : 'Early start'}>{fmtShort(taskStart(t))}</span>
        <span class={`c date mono ${t.ae ? 'actual' : ''}`} style={{ width: `${COLS.finish}px` }} title={t.ae ? 'Actual finish' : 'Early finish'}>{fmtShort(taskFinish(t))}</span>
        <span class={`c num ${tfDays !== null && tfDays < 0 ? 'neg' : ''}`} style={{ width: `${COLS.tf}px` }}>{t.status === 'Complete' ? '' : hoursToDays(t.tf, dh)}</span>
        <span class="c status" style={{ width: `${COLS.status}px` }}>
          <span class={`sdot s-${t.status}`} />{STATUS_LABEL[t.status]}{t.status === 'Active' && <span class="pct">{Math.round(t.pct)}%</span>}
        </span>
      </div>
    </div>
  );
}

// ---- empty state, help popover, tooltip, details ------------------------------------------

const BUILD_PROMPTS = [
  'Build a 25-activity schedule for a two-storey office fit-out: demolition, framing, MEP rough-in, drywall, finishes, closeout. Start on the project start date, FS logic, milestones for NTP and Substantial Completion.',
  'Create WBS nodes for Preconstruction, Sitework, Structure, Envelope, Interiors, Closeout',
];

function EmptySchedule() {
  return (
    <div class="empty-sched">
      <div class="es-card">
        <div class="es-title">No activities yet.</div>
        <div class="es-text">Describe the project to the agent and it will build the schedule. Try:</div>
        {BUILD_PROMPTS.map((p) => <button key={p} class="link-btn" onClick={() => prefillChat(p)}>{p}</button>)}
      </div>
    </div>
  );
}

function Help({ showLate }: { showLate: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div class="help" ref={ref}>
      <button class={`icon-btn ${open ? 'on' : ''}`} title="Legend and view options" onClick={() => setOpen(!open)}>?</button>
      {open && (
        <div class="pop">
          <div class="pop-h">Legend</div>
          <div class="legend">
            <span><i class="lg norm" />Not started</span>
            <span><i class="lg act" />Active (dark = done)</span>
            <span><i class="lg done" />Complete</span>
            <span><i class="lg crit" />Critical</span>
            <span><i class="lg drv" />Driving path</span>
            <span><i class="lg ms" />Milestone</span>
            <span><i class="lg dd" />Data date</span>
            <span><i class="lg edited" />Just edited</span>
          </div>
          <div class="pop-h">View</div>
          <label class="check"><input type="checkbox" checked={showLate} onChange={(e) => setShowLate((e.currentTarget as HTMLInputElement).checked)} />Show late-date bars</label>
          <div class="pop-h">Keys</div>
          <div class="keys"><span>↑ ↓</span>move selection<span>⌘ click</span>add to selection<span>Esc</span>clear<span>⌘Z / ⇧⌘Z</span>undo / redo</div>
        </div>
      )}
    </div>
  );
}

function Tip({ t, snap, x, y }: { t: SnapTask; snap: Snapshot; x: number; y: number }) {
  const dh = dayHoursOf(snap, t);
  const left = Math.min(x + 14, window.innerWidth - 300);
  const top = y + 16 + 110 > window.innerHeight ? y - 110 : y + 16;
  const tags = [t.critical && t.status !== 'Complete' && 'critical', t.driving && 'driving'].filter(Boolean).join(' · ');
  return (
    <div class="tip" style={{ left: `${left}px`, top: `${top}px` }}>
      <div class="tip-h"><span class="mono">{t.code}</span> {t.name}</div>
      <div class="tip-g">
        <span>Start</span><span class="mono">{fmtShort(taskStart(t))}</span>
        <span>Finish</span><span class="mono">{fmtShort(taskFinish(t))}</span>
        <span>Duration</span><span>{hoursToDays(t.dur, dh)}d, {hoursToDays(t.remain, dh)}d left</span>
        <span>Float</span><span>{t.tf === null ? '—' : `${hoursToDays(t.tf, dh)}d`}{tags ? ` · ${tags}` : ''}</span>
      </div>
    </div>
  );
}

function Details({ t, snap, rels, taskById }: { t: SnapTask; snap: Snapshot; rels: SnapRel[]; taskById: (id: number) => SnapTask | undefined }) {
  const dh = dayHoursOf(snap, t);
  const d = (h: number | null) => (h === null ? '—' : `${hoursToDays(h, dh)}d`);
  const preds = rels.filter((r) => r.succ === t.id);
  const succs = rels.filter((r) => r.pred === t.id);
  const lag = (r: SnapRel) => (r.lag ? ` ${r.lag > 0 ? '+' : ''}${hoursToDays(r.lag, dh)}d` : '');
  const Link = ({ r, other }: { r: SnapRel; other: number }) => {
    const o = taskById(other);
    return (
      <button class={`dlink ${r.driving ? 'driving' : ''}`} onClick={() => select(other, { scroll: true })} title={`${o?.name ?? ''}${r.driving ? ' (driving)' : ''}`}>
        <span class="mono">{o?.code ?? other}</span><span class="rtype">{r.type}{lag(r)}</span><span class="dname">{o?.name ?? ''}</span>
      </button>
    );
  };
  const cal = snap.calendars.find((c) => c.id === t.cal);
  const range = (a: string, b: string) => <span class="mono">{!a && !b ? '—' : `${fmtShort(a) || '—'} – ${fmtShort(b) || '—'}`}</span>;
  return (
    <div class="details">
      <div class="det-head">
        <span class="mono det-code">{t.code}</span>
        <span class="det-name">{t.name}</span>
        {t.critical && t.status !== 'Complete' && <span class="tag crit">critical</span>}
        {t.driving && <span class="tag drv">driving</span>}
        <span class="grow" />
        <button class="icon-btn" onClick={() => setDetailsOpen(false)} title="Hide details">–</button>
        <button class="icon-btn" onClick={() => select(null)} title="Clear selection (Esc)">✕</button>
      </div>
      <div class="det-body">
        <div class="det-grid">
          <span>Type</span><span>{TYPE_LABEL[t.type] ?? t.type}</span>
          <span>Early</span>{range(t.es, t.ef)}
          <span>Status</span><span>{STATUS_LABEL[t.status]}{t.status === 'Active' ? ` · ${Math.round(t.pct)}%` : ''}</span>
          <span>Late</span>{range(t.ls, t.lf)}
          <span>Duration</span><span>{d(t.dur)}, {d(t.remain)} left</span>
          <span>Actual</span>{range(t.as, t.ae)}
          <span>Calendar</span><span>{cal ? `${cal.name} (${cal.dayHours}h)` : t.cal}</span>
          <span>Float</span><span class={t.tf !== null && t.tf < 0 ? 'neg' : ''}>{d(t.tf)} total, {d(t.ff)} free</span>
          <span>Constraint</span><span>{t.cstr ? <>{t.cstr} <span class="mono">{fmtShort(t.cstrDate)}</span></> : '—'}</span>
        </div>
        <div class="rels">
          <div class="rel-h">Predecessors <span>{preds.length}</span></div>
          {preds.length ? preds.map((r) => <Link key={r.id} r={r} other={r.pred} />) : <div class="none">none (open start)</div>}
        </div>
        <div class="rels">
          <div class="rel-h">Successors <span>{succs.length}</span></div>
          {succs.length ? succs.map((r) => <Link key={r.id} r={r} other={r.succ} />) : <div class="none">none (open end)</div>}
        </div>
      </div>
    </div>
  );
}
