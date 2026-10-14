import { EventEmitter } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseXer } from './xer/parse.ts';
import { serializeXer } from './xer/serialize.ts';
import type { XerFile } from './xer/types.ts';
import { Schedule, type FieldChange } from './schedule/model.ts';
import { runCpm, applyCpm, CpmCycleError, type CpmResult } from './schedule/cpm.ts';
import { snapshotOf, diffSnapshots, compactDiff, type Snapshot, type Patch, type CompactDiff } from './schedule/diff.ts';

interface HistoryEntry { label: string; turn: string; xer: XerFile; cpm: CpmResult; snapshot: Snapshot }

/** One open XER file: raw tables, typed schedule, CPM result, history, and a 'patch' event stream. */
export class Document extends EventEmitter {
  readonly file: string;
  readonly original: Uint8Array;
  xer: XerFile;
  sched: Schedule;
  cpm: CpmResult;
  seq = 0;
  history: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];
  private snap: Snapshot;
  mutations = 0;

  constructor(file: string, bytes: Uint8Array) {
    super();
    this.file = file;
    this.original = bytes;
    this.xer = parseXer(bytes);
    this.sched = new Schedule(this.xer);
    this.cpm = runCpm(this.sched);
    applyCpm(this.sched, this.cpm);
    this.snap = snapshotOf(this.sched, this.cpm, file, this.seq, 0);
  }

  snapshot(): Snapshot { return this.snap; }

  /**
   * Run a mutation against the schedule, reschedule, and broadcast a patch.
   * On a CPM cycle (or any throw) the document is restored exactly as it was.
   */
  mutate(turn: string, label: string, fn: (s: Schedule) => FieldChange[] | void): CompactDiff {
    const before: HistoryEntry = { label, turn, xer: structuredClone(this.xer), cpm: this.cpm, snapshot: this.snap };
    const changes: FieldChange[] = [];
    try {
      const r = fn(this.sched);
      if (Array.isArray(r)) changes.push(...r);
      this.sched.invalidateCalendars();
      this.cpm = runCpm(this.sched);
      changes.push(...applyCpm(this.sched, this.cpm));
    } catch (e) {
      this.xer = before.xer; this.sched = new Schedule(this.xer); this.cpm = before.cpm;
      if (e instanceof CpmCycleError) throw e;
      throw e;
    }
    this.history.push(before);
    if (this.history.length > 50) this.history.shift();
    this.redoStack = [];
    this.mutations++;
    return this.commit(turn, label, before.snapshot, changes, this.cpm.warnings);
  }

  private commit(turn: string, label: string, prev: Snapshot, changes: FieldChange[], warnings: string[]): CompactDiff {
    this.seq++;
    this.snap = snapshotOf(this.sched, this.cpm, this.file, this.seq, this.mutations);
    const ops = diffSnapshots(prev, this.snap);
    const patch: Patch = { seq: this.seq, turn, label, ops, changedSinceLoad: this.mutations, warnings };
    this.emit('patch', patch);
    return compactDiff(label, prev, this.snap, changes, this.sched, warnings);
  }

  /** Undo the last n mutations (or every mutation of a turn). */
  undo(turn: string, opts: { steps?: number; scope?: 'call' | 'turn'; ofTurn?: string } = {}): CompactDiff {
    const scope = opts.scope ?? 'call';
    let steps = opts.steps ?? 1;
    if (scope === 'turn') {
      const target = opts.ofTurn ?? this.history.at(-1)?.turn;
      steps = 0; for (let i = this.history.length - 1; i >= 0 && this.history[i]!.turn === target; i--) steps++;
    }
    if (steps === 0 || !this.history.length) throw new Error('nothing to undo');
    const prev = this.snap;
    let entry: HistoryEntry | undefined;
    const labels: string[] = [];
    for (let i = 0; i < steps && this.history.length; i++) {
      entry = this.history.pop()!;
      labels.unshift(entry.label);
      this.redoStack.push({ label: entry.label, turn: entry.turn, xer: structuredClone(this.xer), cpm: this.cpm, snapshot: this.snap });
      this.xer = entry.xer; this.sched = new Schedule(this.xer); this.cpm = entry.cpm; this.snap = entry.snapshot;
      this.mutations = Math.max(0, this.mutations - 1);
    }
    return this.commit(turn, `undo: ${labels.join(', ')}`, prev, [], []);
  }

  redo(turn: string): CompactDiff {
    const e = this.redoStack.pop();
    if (!e) throw new Error('nothing to redo');
    const prev = this.snap;
    this.history.push({ label: e.label, turn: e.turn, xer: structuredClone(this.xer), cpm: this.cpm, snapshot: this.snap });
    this.xer = e.xer; this.sched = new Schedule(this.xer); this.cpm = e.cpm; this.snap = e.snapshot;
    this.mutations++;
    return this.commit(turn, `redo: ${e.label}`, prev, [], []);
  }

  exportBytes(): Uint8Array {
    // Make sure the file carries the latest schedule result.
    applyCpm(this.sched, this.cpm);
    return serializeXer(this.xer);
  }

  async exportTo(dir: string, name?: string): Promise<{ path: string; bytes: number }> {
    await mkdir(dir, { recursive: true });
    const base = (name ?? path.basename(this.file, '.xer') + '-edited').replace(/[^\w.-]+/g, '_').replace(/\.xer$/i, '');
    const p = path.join(dir, `${base}.xer`);
    const bytes = this.exportBytes();
    await writeFile(p, bytes);
    return { path: p, bytes: bytes.length };
  }
}
