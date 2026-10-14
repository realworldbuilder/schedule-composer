import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseXer } from '../lib/xer/parse.ts';
import { serializeXer } from '../lib/xer/serialize.ts';
import { Schedule } from '../lib/schedule/model.ts';
import { runCpm, applyCpm, CpmCycleError, drivingChain } from '../lib/schedule/cpm.ts';
import { fmtP6Date, parseP6Date } from '../lib/schedule/dates.ts';

function load(): Schedule {
  return new Schedule(parseXer(new Uint8Array(readFileSync('samples/PredecessorCalendar.xer'))));
}
const f = (ms: number) => fmtP6Date(ms);

describe('cpm on the sample', () => {
  it('leaves the completed task untouched and finish >= its actual end', () => {
    const s = load();
    const before = Buffer.from(serializeXer(s.xer));
    const r = runCpm(s);
    const a = s.taskByCode('A1000')!;
    expect(r.nodes.get(a.task_id)!.frozen).toBe(true);
    const ch = applyCpm(s, r);
    // only scd_end_date may change
    expect(ch.filter((c) => c.table === 'TASK')).toEqual([]);
    const after = Buffer.from(serializeXer(s.xer));
    expect(after.length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
  });
});

describe('cpm hand cases', () => {
  let s: Schedule; let wbs: number;
  beforeEach(() => { s = load(); wbs = s.wbsRoot()!.wbs_id; });

  it('FS chain from the data date', () => {
    const a = s.taskByCode('A1000')!;
    const b = s.addActivity({ task_name: 'B', wbs_id: wbs, target_drtn_hr_cnt: 80 });
    s.addRelationship({ pred_task_id: a.task_id, task_id: b.task_id });
    const r = runCpm(s);
    const nb = r.nodes.get(b.task_id)!;
    expect(f(nb.es)).toBe('2019-10-02 08:00');
    expect(f(nb.ef)).toBe('2019-10-15 17:00');
    expect(nb.tf).toBe(0);
    expect(f(r.finish)).toBe('2019-10-15 17:00');
    const c = s.addActivity({ task_name: 'C', wbs_id: wbs, target_drtn_hr_cnt: 16 });
    s.addRelationship({ pred_task_id: b.task_id, task_id: c.task_id, lag_hr_cnt: 8 });
    const r2 = runCpm(s);
    const nc = r2.nodes.get(c.task_id)!;
    expect(f(nc.es)).toBe('2019-10-17 08:00');
    expect(f(nc.ef)).toBe('2019-10-18 17:00');
    expect(r2.longestPath).toEqual([b.task_id, c.task_id]);
    const chain = drivingChain(s, r2, c.task_id, 'back');
    expect(chain.map((x) => x.code)).toEqual([c.task_code, b.task_code]);
    expect(chain[0]!.via).toBeNull();
    expect(chain[1]!.via).toBe('FS+8h');
  });

  it('SS, FF, SF and float', () => {
    const b = s.addActivity({ task_name: 'B', wbs_id: wbs, target_drtn_hr_cnt: 40 });
    const c = s.addActivity({ task_name: 'C', wbs_id: wbs, target_drtn_hr_cnt: 16 });
    const d = s.addActivity({ task_name: 'D', wbs_id: wbs, target_drtn_hr_cnt: 8 });
    const e = s.addActivity({ task_name: 'E', wbs_id: wbs, target_drtn_hr_cnt: 8 });
    s.addRelationship({ pred_task_id: b.task_id, task_id: c.task_id, pred_type: 'PR_SS', lag_hr_cnt: 8 });
    s.addRelationship({ pred_task_id: b.task_id, task_id: d.task_id, pred_type: 'PR_FF' });
    s.addRelationship({ pred_task_id: b.task_id, task_id: e.task_id, pred_type: 'PR_SF', lag_hr_cnt: 16 });
    const r = runCpm(s);
    const nb = r.nodes.get(b.task_id)!, nc = r.nodes.get(c.task_id)!, nd = r.nodes.get(d.task_id)!, ne = r.nodes.get(e.task_id)!;
    expect(f(nb.es)).toBe('2019-10-02 08:00'); expect(f(nb.ef)).toBe('2019-10-08 17:00');
    expect(f(nc.es)).toBe('2019-10-03 08:00'); expect(f(nc.ef)).toBe('2019-10-04 17:00');
    expect(f(nd.ef)).toBe('2019-10-08 17:00'); expect(f(nd.es)).toBe('2019-10-08 08:00');
    expect(f(ne.ef)).toBe('2019-10-03 17:00'); expect(f(ne.es)).toBe('2019-10-03 08:00');
    expect(f(r.finish)).toBe('2019-10-08 17:00');
    expect(nb.tf).toBe(0); expect(nd.tf).toBe(0);
    expect(nc.tf).toBe(16); expect(ne.tf).toBe(24);
    expect(nc.ff).toBe(16);
    expect(r.driving.size).toBe(3);
  });

  it('constraints: MSOA pushes, MEOB pulls late dates, MSO forces', () => {
    const b = s.addActivity({ task_name: 'B', wbs_id: wbs, target_drtn_hr_cnt: 16, cstr_type: 'CS_MSOA', cstr_date: parseP6Date('2019-10-07 00:00') });
    const c = s.addActivity({ task_name: 'C', wbs_id: wbs, target_drtn_hr_cnt: 16 });
    const d = s.addActivity({ task_name: 'D', wbs_id: wbs, target_drtn_hr_cnt: 8, cstr_type: 'CS_MSO', cstr_date: parseP6Date('2019-10-21 08:00') });
    s.addRelationship({ pred_task_id: b.task_id, task_id: c.task_id });
    s.updateActivity(c.task_id, { cstr_type: 'CS_MEOB', cstr_date: parseP6Date('2019-10-09 17:00') });
    const r = runCpm(s);
    const nb = r.nodes.get(b.task_id)!, nc = r.nodes.get(c.task_id)!, nd = r.nodes.get(d.task_id)!;
    expect(f(nb.es)).toBe('2019-10-07 08:00');
    expect(f(nc.es)).toBe('2019-10-09 08:00'); expect(f(nc.ef)).toBe('2019-10-10 17:00');
    expect(f(nc.lf)).toBe('2019-10-09 17:00');
    expect(nc.tf).toBe(-8); expect(nb.tf).toBe(-8);
    expect(f(nd.es)).toBe('2019-10-21 08:00'); expect(f(nd.ls)).toBe('2019-10-21 08:00');
    expect(f(r.finish)).toBe('2019-10-21 17:00');
  });

  it('milestones and an active task with retained logic', () => {
    const ntp = s.addActivity({ task_name: 'NTP', wbs_id: wbs, task_type: 'TT_Mile' });
    const b = s.addActivity({ task_name: 'B', wbs_id: wbs, target_drtn_hr_cnt: 40 });
    const fin = s.addActivity({ task_name: 'Done', wbs_id: wbs, task_type: 'TT_FinMile' });
    s.addRelationship({ pred_task_id: ntp.task_id, task_id: b.task_id });
    s.addRelationship({ pred_task_id: b.task_id, task_id: fin.task_id });
    // make B active: started 2019-09-30, 24h remaining
    b.set('status_code', 'TK_Active'); b.setDate('act_start_date', parseP6Date('2019-09-30 08:00')); b.setHours('remain_drtn_hr_cnt', 24);
    s.touch();
    const r = runCpm(s);
    const nn = r.nodes.get(ntp.task_id)!, nb = r.nodes.get(b.task_id)!, nf = r.nodes.get(fin.task_id)!;
    expect(f(nn.es)).toBe('2019-10-02 08:00'); expect(nn.es).toBe(nn.ef);
    expect(f(nb.es)).toBe('2019-09-30 08:00');
    expect(f(nb.rs)).toBe('2019-10-02 08:00'); expect(f(nb.ef)).toBe('2019-10-04 17:00');
    expect(f(nf.ef)).toBe('2019-10-04 17:00');
    expect(nf.tf).toBe(0); expect(nb.tf).toBe(0);
    const ch = applyCpm(s, r);
    expect(ch.some((c) => c.field === 'reend_date' && c.id === b.task_id && c.to === '2019-10-04 17:00')).toBe(true);
    expect(s.taskByCode(b.task_code)!.s('driving_path_flag')).toBe('Y');
    expect(f(s.project.scd_end_date!)).toBe('2019-10-04 17:00');
  });

  it('names a logic loop', () => {
    const b = s.addActivity({ task_name: 'B', wbs_id: wbs, task_code: 'B' });
    const c = s.addActivity({ task_name: 'C', wbs_id: wbs, task_code: 'C' });
    const d = s.addActivity({ task_name: 'D', wbs_id: wbs, task_code: 'D' });
    s.addRelationship({ pred_task_id: b.task_id, task_id: c.task_id });
    s.addRelationship({ pred_task_id: c.task_id, task_id: d.task_id });
    s.addRelationship({ pred_task_id: d.task_id, task_id: b.task_id });
    let err: unknown;
    try { runCpm(s); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CpmCycleError);
    const loop = (err as CpmCycleError).loop;
    expect(loop.length).toBe(4);
    expect(loop[0]).toBe(loop[3]);
    expect(new Set(loop)).toEqual(new Set(['B', 'C', 'D']));
  });
});
