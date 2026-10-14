import { useEffect, useRef, useState } from 'preact/hooks';
import type { CompactDiff } from '../../lib/schedule/diff.ts';
import { useApp, sendChat, interrupt, setDraft, selectByCodes, prefillChat, type Msg, type ToolMsg } from '../store';
import { Markdown } from './markdown';
import { fmtDatesIn, fmtMoney, fmtMs, fmtShort, fmtValue, signedDays } from '../util';

const SUGGESTED = [
  "What's driving substantial completion?",
  'Add a 10-day Punch List activity after the last Interiors activity and before Substantial Completion',
  'Shift the MEP Rough-in WBS by two weeks',
  'Find open ends and negative float',
];
const BUILD = [
  'Build a 25-activity schedule for a two-storey office fit-out: demolition, framing, MEP rough-in, drywall, finishes, closeout. Start on the project start date, FS logic, milestones for NTP and Substantial Completion.',
  'Create WBS nodes for Preconstruction, Sitework, Structure, Envelope, Interiors, Closeout',
];

const TOOLS: Record<string, [icon: string, label: string]> = {
  get_summary: ['◎', 'Read summary'], search_activities: ['⌕', 'Search activities'], get_activity: ['◎', 'Look up activity'], list_wbs: ['◎', 'List WBS'],
  trace_driving: ['⤳', 'Trace driving path'], check_logic: ['✓', 'Check logic'],
  add_activity: ['+', 'Add activity'], add_activities: ['+', 'Add activities'], update_activities: ['✎', 'Update activities'], delete_activities: ['−', 'Delete activities'],
  add_relationships: ['⇢', 'Link activities'], update_relationships: ['⇢', 'Update links'], delete_relationships: ['⇢', 'Remove links'],
  shift_activities: ['↦', 'Shift activities'], add_wbs: ['▤', 'Add WBS'], reschedule: ['↻', 'Reschedule'], undo_last: ['↶', 'Undo'], export_xer: ['↓', 'Export XER'],
};
const READS = new Set(['get_summary', 'search_activities', 'get_activity', 'list_wbs', 'trace_driving', 'check_logic']);

const bare = (name: string) => name.replace(/^mcp__\w+__/, '');
function toolInfo(name: string): [string, string] {
  const n = bare(name);
  return TOOLS[n] ?? ['•', n.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())];
}

export function Chat() {
  const s = useApp();
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = list.current; if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [s.messages, s.working]);

  // prefillChat() from the empty schedule: focus the input with the caret at the end
  useEffect(() => {
    const el = ta.current; if (!el || !s.focusSeq) return;
    el.focus(); el.setSelectionRange(el.value.length, el.value.length);
  }, [s.focusSeq]);

  const onScroll = () => { const el = list.current; if (!el) return; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  const send = () => { if (s.working || !s.draft.trim()) return; stick.current = true; sendChat(s.draft); ta.current?.focus(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && s.working) { e.preventDefault(); interrupt(); }
  };
  const lastTool = s.messages[s.messages.length - 1];
  const thinking = s.working && !(lastTool?.kind === 'tool' && !lastTool.done);
  const empty = !!s.snapshot && s.snapshot.tasks.length === 0;

  return (
    <div class="chat">
      <div class="chat-head">
        <span class="title">Agent</span>
      </div>
      <div class="chat-list" ref={list} onScroll={onScroll}>
        {s.messages.length === 0 && (
          <div class="suggest">
            <div class="hint">{empty
              ? 'This project is empty. Describe the work and the agent will build WBS, activities and logic. Every edit lands in the schedule as it happens and can be undone.'
              : 'Ask for an analysis or tell the agent what to change. Every edit shows up in the schedule as it happens and can be undone.'}</div>
            {(empty ? BUILD : SUGGESTED).map((p) => (
              <button key={p} class="link-btn" disabled={!s.snapshot} onClick={() => { if (empty) prefillChat(p); else { stick.current = true; sendChat(p); } }}>{p}</button>
            ))}
          </div>
        )}
        {s.messages.map((m, i) => <Message key={m.kind === 'tool' ? m.id : i} m={m} />)}
        {thinking && <div class="thinking"><span /><span /><span /></div>}
      </div>
      <div class="chat-input">
        <textarea
          ref={ta}
          value={s.draft}
          placeholder={s.snapshot ? (empty ? 'Describe the project…' : 'Ask or instruct…') : 'Open or start a schedule first'}
          rows={3}
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={onKey}
        />
        <div class="row">
          <span class="hint-line">{s.working ? 'Working · Esc to stop' : s.online ? 'Enter to send · Shift+Enter for a new line' : 'Reconnecting…'}</span>
          <span class="grow" />
          {s.working && <button class="tb ghost danger" onClick={interrupt} title="Interrupt the running turn (Esc)">Stop</button>}
          <button class="tb primary" disabled={s.working || !s.draft.trim() || !s.snapshot} onClick={send}>Send</button>
        </div>
      </div>
    </div>
  );
}

function Message({ m }: { m: Msg }) {
  switch (m.kind) {
    case 'user': return <div class="msg user"><div class="bubble">{m.text}</div></div>;
    case 'assistant': return <div class="msg assistant"><div class="md"><Markdown text={m.text} /></div></div>;
    case 'tool': return <ToolCard m={m} />;
    case 'end':
      return m.ok
        ? <div class="turn-end">{[m.duration_ms !== undefined && fmtMs(m.duration_ms), m.cost_usd !== undefined && fmtMoney(m.cost_usd), m.num_turns !== undefined && `${m.num_turns} step${m.num_turns === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'done'}</div>
        : <div class="turn-end err">{m.error ?? 'The turn failed.'}</div>;
  }
}

function inputLine(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'object') return String(input);
  if (Array.isArray(input)) return short(input);
  const parts = Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}: ${short(v)}`);
  const line = parts.join(', ');
  return line.length > 160 ? line.slice(0, 157) + '…' : line;
}
function short(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) {
    const items = v.slice(0, 6).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)));
    return `[${items.join(', ')}${v.length > 6 ? `, +${v.length - 6}` : ''}]`;
  }
  return JSON.stringify(v);
}

/** Activity codes a card touched, for selecting them in the grid. */
function codesOf(m: ToolMsg): string[] {
  const out = new Set<string>();
  const first = (s: string) => s.trim().split(/\s+/)[0] ?? '';
  if (m.diff) { for (const a of m.diff.added) out.add(first(a)); for (const u of m.diff.updated) out.add(u.code); }
  const inp = m.input as Record<string, unknown> | undefined;
  if (inp && typeof inp === 'object') {
    for (const k of ['code', 'codes', 'activity', 'activities', 'task', 'tasks']) {
      const v = inp[k];
      if (typeof v === 'string') out.add(v);
      if (Array.isArray(v)) for (const x of v) { if (typeof x === 'string') out.add(x); else if (x && typeof x === 'object' && typeof (x as { code?: unknown }).code === 'string') out.add((x as { code: string }).code); }
    }
  }
  const data = m.data as unknown;
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data as Record<string, unknown>).find(Array.isArray) : null;
  if (Array.isArray(rows)) for (const r of rows.slice(0, 500)) if (r && typeof r === 'object' && typeof (r as { code?: unknown }).code === 'string') out.add((r as { code: string }).code);
  return [...out].filter(Boolean);
}

/** "A1310" / "A1310 +4" / "+25 activities": who a write touched, for the one-line outcome. */
function target(d: CompactDiff): string {
  const first = (x: string) => x.trim().split(/\s+/)[0] ?? '';
  if (d.added.length > 1) return `+${d.added.length} activities`;
  const codes = [...new Set([...d.added.map(first), ...d.updated.map((u) => u.code)])].filter((c) => c && !c.includes('->'));
  if (codes.length) return codes.length === 1 ? codes[0]! : `${codes[0]} +${codes.length - 1}`;
  if (d.deleted.length) return `−${d.deleted.length} activit${d.deleted.length === 1 ? 'y' : 'ies'}`;
  const r = d.relationships;
  const links = r.added.length + r.deleted.length + r.updated.length;
  if (links) return `${links} link${links === 1 ? '' : 's'}`;
  return '';
}
function finishPhrase(d: CompactDiff): string {
  if (d.cpm.finish.from === d.cpm.finish.to) return 'finish unchanged';
  const n = d.cpm.finishDeltaDays;
  const abs = Math.abs(n);
  return `finish ${n > 0 ? '+' : n < 0 ? '−' : '±'}${abs} work day${abs === 1 ? '' : 's'}`;
}
function outcome(m: ToolMsg): string {
  if (!m.done) return inputLine(m.input);
  if (!m.ok || !m.diff) return fmtDatesIn(m.summary ?? '');
  const who = target(m.diff);
  if (!who) return [fmtDatesIn(m.summary ?? ''), m.diff.cpm.finish.from !== m.diff.cpm.finish.to && finishPhrase(m.diff)].filter(Boolean).join(' · ');
  return [who, finishPhrase(m.diff)].join(' · ');
}

function ToolCard({ m }: { m: ToolMsg }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const read = READS.has(bare(m.name));
  const [icon, name] = toolInfo(m.name);
  const codes = codesOf(m);
  const line = inputLine(m.input);
  const out = outcome(m);
  const state = m.done ? (m.ok ? 'ok' : 'failed') : 'running';
  const later = m.diff && m.diff.cpm.finishDeltaHours > 0 ? 'later' : m.diff && m.diff.cpm.finishDeltaHours < 0 ? 'earlier' : '';
  return (
    <div class={`tool ${read ? 'read' : 'write'} ${state} ${open ? 'open' : ''}`}>
      <button class="tool-head" onClick={() => setOpen(!open)} title={m.summary ?? line}>
        <span class="tool-ico">{m.done ? (m.ok ? icon : '!') : <span class="spin" />}</span>
        <span class="tool-name">{name}</span>
        {out && <span class={`tool-out ${m.diff && !read ? later : ''}`}>{out}</span>}
        <span class="tool-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div class="tool-body">
          {m.done && m.summary && fmtDatesIn(m.summary) !== out && <div class={`tool-sum ${m.ok ? '' : 'err'}`}>{fmtDatesIn(m.summary)}</div>}
          {line && <div class="tool-input mono">{line}</div>}
          {m.diff && <DiffChips d={m.diff} />}
          <div class="tool-links">
            {codes.length > 0 && <button class="link-btn" onClick={() => selectByCodes(codes)}>Select {codes.length} in schedule</button>}
            {(m.diff || m.data !== undefined) && <button class="link-btn" onClick={() => setMore(!more)}>{more ? 'Hide details' : m.diff ? 'Show every change' : 'Show raw result'}</button>}
          </div>
          {more && m.diff && <DiffDetails d={m.diff} />}
          {more && m.data !== undefined && <pre class="tool-data">{truncate(JSON.stringify(m.data, null, 1), 20000)}</pre>}
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s; }

function DiffChips({ d }: { d: CompactDiff }) {
  const rel = d.relationships;
  const fin = d.cpm.finish;
  const moved = fin.from !== fin.to;
  const dh = d.cpm.finishDeltaHours;
  const links = rel.added.length + rel.deleted.length + rel.updated.length;
  return (
    <div class="chips">
      {d.added.length > 0 && <span class="chip add">+{d.added.length} added</span>}
      {d.deleted.length > 0 && <span class="chip del">−{d.deleted.length} deleted</span>}
      {d.updatedCount > 0 && <span class="chip">{d.updatedCount} field{d.updatedCount === 1 ? '' : 's'} changed</span>}
      {links > 0 && <span class="chip">{[rel.added.length && `+${rel.added.length}`, rel.deleted.length && `−${rel.deleted.length}`, rel.updated.length && `~${rel.updated.length}`].filter(Boolean).join(' ')} link{links === 1 ? '' : 's'}</span>}
      {moved
        ? <span class={`chip ${dh > 0 ? 'later' : 'earlier'}`} title={`${fin.from} → ${fin.to}`}>finish <span class="mono">{fmtShort(fin.from)} → {fmtShort(fin.to)}</span> ({signedDays(dh)})</span>
        : <span class="chip">finish unchanged</span>}
      {d.cpm.moved > 0 && <span class="chip">{d.cpm.moved} dates moved</span>}
      <span class="chip">{d.cpm.critical} critical</span>
      {d.cpm.negativeFloat > 0 && <span class="chip del">{d.cpm.negativeFloat} negative float</span>}
      {d.warnings.length > 0 && <span class="chip warn" title={d.warnings.join('\n')}>{d.warnings.length} warning{d.warnings.length === 1 ? '' : 's'}</span>}
    </div>
  );
}

function DiffDetails({ d }: { d: CompactDiff }) {
  const rel = d.relationships;
  const Sec = ({ title, items }: { title: string; items: string[] }) => items.length ? (
    <div class="dsec"><div class="dtitle">{title} <span class="muted">{items.length}</span></div>{items.map((x, i) => <div key={i} class="ditem">{x}</div>)}</div>
  ) : null;
  return (
    <div class="ddetails">
      <Sec title="Added" items={d.added} />
      <Sec title="Deleted" items={d.deleted} />
      {d.updated.length > 0 && (
        <div class="dsec">
          <div class="dtitle">Updated <span class="muted">{d.updatedCount}{d.updatedCount > d.updated.length ? ` (first ${d.updated.length})` : ''}</span></div>
          {d.updated.map((u, i) => <div key={i} class="ditem"><span class="mono">{u.code}</span> {u.field}: <span class="from">{fmtValue(u.from) || '∅'}</span> → <span class="to">{fmtValue(u.to) || '∅'}</span></div>)}
        </div>
      )}
      <Sec title="Relationships added" items={rel.added} />
      <Sec title="Relationships deleted" items={rel.deleted} />
      <Sec title="Relationships changed" items={rel.updated} />
      <Sec title="Warnings" items={d.warnings} />
    </div>
  );
}
