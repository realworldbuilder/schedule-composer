import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../lib/state.ts';
import { handlers, type ToolCtx } from '../lib/agent/tools.ts';
import { serializeXer } from '../lib/xer/serialize.ts';
import { parseXer } from '../lib/xer/parse.ts';

let doc: Document; let ctx: ToolCtx; let patches = 0;
beforeEach(() => {
  doc = new Document('generated-200.xer', new Uint8Array(readFileSync('samples/generated-200.xer')));
  patches = 0; doc.on('patch', () => patches++);
  ctx = { doc: () => doc, turn: () => 't1', exportDir: 'data/exports' };
});

describe('agent tools', () => {
  it('summary and search are bounded', async () => {
    const s = await handlers.get_summary(ctx);
    const d = s.data as { counts: { activities: number }; wbs: unknown[]; longest_path: string[] };
    expect(d.counts.activities).toBe(200);
    expect(d.wbs.length).toBe(10);
    expect(d.longest_path.length).toBeGreaterThan(3);
    const r = await handlers.search_activities(ctx, { wbs: 'MEP', limit: 5 });
    const rd = r.data as { total: number; rows: unknown[]; next_offset: number | null };
    expect(rd.rows.length).toBe(5); expect(rd.total).toBeGreaterThan(5); expect(rd.next_offset).toBe(5);
    const c = await handlers.search_activities(ctx, { critical: true, limit: 200 });
    expect((c.data as { total: number }).total).toBeGreaterThan(10);
    await expect(handlers.search_activities(ctx, { wbs: 'NOPE' })).rejects.toThrow(/not found/);
  });

  it('adds an activity after X and before Y, then undoes it byte-identically', async () => {
    const before = Buffer.from(serializeXer(doc.xer));
    const finish0 = doc.snapshot().project.finish;
    const last = (await handlers.search_activities(ctx, { q: 'Final Clean' })).data as { rows: { code: string }[] };
    const sc = (await handlers.search_activities(ctx, { q: 'Substantial Completion' })).data as { rows: { code: string }[] };
    const r = await handlers.add_activity(ctx, { name: 'Punch List Phase 2', wbs: 'CLO', duration: { days: 10 }, after: { code: last.rows[0]!.code }, before: { code: sc.rows[0]!.code } });
    expect(r.diff!.added.length).toBe(1);
    expect(r.diff!.relationships.added.length).toBe(2);
    expect(r.diff!.cpm.finishDeltaHours).toBe(80);
    expect(patches).toBe(1);
    expect(doc.snapshot().tasks.length).toBe(201);
    const u = await handlers.undo_last(ctx, {});
    expect(u.diff!.cpm.finish.to).toBe(finish0);
    expect(Buffer.from(serializeXer(doc.xer)).equals(before)).toBe(true);
    expect(doc.snapshot().tasks.length).toBe(200);
  });

  it('bulk SS+5 inside a WBS, shift a WBS, delete, logic check', async () => {
    const r = await handlers.update_relationships(ctx, { match: { wbs: 'INT', type: 'FS' }, set: { type: 'SS', lag: { days: 5 } } });
    expect(r.diff!.relationships.updated.length).toBeGreaterThan(5);
    expect(r.diff!.cpm.finishDeltaHours).toBeLessThan(0);
    const sh = await handlers.shift_activities(ctx, { wbs: 'MEP', by: { days: 10 } });
    expect(sh.diff!.updatedCount).toBeGreaterThan(10);
    const row = (await handlers.search_activities(ctx, { wbs: 'MEP', status: 'NotStart', limit: 1 })).data as { rows: { cstr: string }[] };
    expect(row.rows[0]!.cstr).toMatch(/^MSOA /);
    const cl = await handlers.check_logic(ctx, {});
    const d = cl.data as { open_ends: { count: number }; constraints: { count: number } };
    expect(d.constraints.count).toBeGreaterThan(10);
    await expect(handlers.delete_activities(ctx, { codes: ['ZZZ9'] })).rejects.toThrow(/no activity/);
    const first = (await handlers.search_activities(ctx, { wbs: 'PRE', status: 'NotStart', limit: 1 })).data as { rows: { code: string }[] };
    if (first.rows[0]) { const del = await handlers.delete_activities(ctx, { codes: [first.rows[0].code] }); expect(del.diff!.deleted.length).toBe(1); }
    await expect(handlers.add_relationships(ctx, { links: [{ pred: 'A1010', succ: 'A1010' }] })).rejects.toThrow(/own predecessor/);
    expect(doc.history.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a loop and leaves the document unchanged', async () => {
    const before = Buffer.from(serializeXer(doc.xer));
    const t = (await handlers.trace_driving(ctx, {})).data as { chain: { code: string }[] };
    expect(t.chain.length).toBeGreaterThan(3);
    const a = t.chain[0]!.code, b = t.chain[2]!.code;
    await expect(handlers.add_relationships(ctx, { links: [{ pred: a, succ: b }] })).rejects.toThrow(/Logic loop/);
    expect(Buffer.from(serializeXer(doc.xer)).equals(before)).toBe(true);
    expect(doc.history.length).toBe(0);
  });
});

describe('blank project', () => {
  it('creates an empty schedule the agent can build up', async () => {
    const { blankProject, clndrData } = await import('../lib/schedule/blank.ts');
    expect(clndrData(8, [1, 2, 3, 4, 5])).toContain('(0||2()((0||0(s|08:00|f|12:00)())(0||1(s|13:00|f|17:00)())))');
    expect(clndrData(10, [1, 2, 3, 4, 5, 6])).toContain('(0||7()((0||0(s|08:00|f|13:00)())(0||1(s|14:00|f|19:00)())))');
    const { file, bytes } = blankProject({ name: 'Test Kitchen Remodel', start: '2027-02-01' });
    expect(file).toBe('tkr.xer');
    const d = new Document(file, bytes);
    const c: ToolCtx = { doc: () => d, turn: () => 't', exportDir: 'data/exports' };
    expect(d.snapshot().tasks.length).toBe(0);
    expect(d.snapshot().project.dataDate).toBe('2027-02-01 00:00');
    expect(d.snapshot().calendars[0]!.dayHours).toBe(8);
    const sum = (await handlers.get_summary(c)).data as { wbs: { code: string }[] };
    expect(sum.wbs[0]!.code).toBe('TKR');
    await handlers.add_wbs(c, { name: 'Demolition', code: 'DEMO', parent: 'TKR' });
    const r = await handlers.add_activities(c, { chain: true, activities: [
      { name: 'NTP', wbs: 'DEMO', type: 'Mile' }, { name: 'Remove cabinets', wbs: 'DEMO', duration: { days: 2 } }, { name: 'Remove flooring', wbs: 'DEMO', duration: { days: 3 } }, { name: 'Demo complete', wbs: 'DEMO', type: 'FinMile' } ] });
    expect((r.data as { codes: string[] }).codes).toEqual(['A1000', 'A1010', 'A1020', 'A1030']);
    expect(r.diff!.relationships.added.length).toBe(3);
    expect(d.snapshot().project.finish).toBe('2027-02-05 17:00');
    const a1010 = d.snapshot().tasks.find((t) => t.code === 'A1010')!;
    expect(a1010.es).toBe('2027-02-01 08:00'); expect(a1010.critical).toBe(true);
    const again = parseXer(serializeXer(d.xer));
    expect(again.tables.find((t) => t.name === 'TASK')!.rows.length).toBe(4);
  });
});
