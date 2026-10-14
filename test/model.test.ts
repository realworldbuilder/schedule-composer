import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseXer } from '../lib/xer/parse.ts';
import { serializeXer } from '../lib/xer/serialize.ts';
import { Schedule } from '../lib/schedule/model.ts';

const load = () => new Schedule(parseXer(new Uint8Array(readFileSync('samples/PredecessorCalendar.xer'))));

describe('model', () => {
  it('reads the sample', () => {
    const s = load();
    expect(s.project.proj_short_name).toBe('TEST PROJECT');
    expect(s.tasks().length).toBe(1);
    expect(s.taskByCode('a1000')!.task_name).toBe('Test');
    expect(s.wbsRoot()!.wbs_short_name).toBe('TEST');
    expect(s.schedOptions).toEqual({ lagCalendar: 'pred', floatType: 'FT_FF', retainedLogic: true, useProjEndForFloat: true });
    expect(s.calendarFor(s.tasks()[0]!).dayHours).toBe(8);
  });

  it('adds an activity from a template with fresh ids and code', () => {
    const s = load();
    const root = s.wbsRoot()!.wbs_id;
    const t = s.addActivity({ task_name: 'New one', wbs_id: root, target_drtn_hr_cnt: 40 });
    expect(t.task_id).toBe(1338402);
    expect(t.task_code).toBe('A1010');
    expect(t.status_code).toBe('TK_NotStart');
    expect(t.target_drtn_hr_cnt).toBe(40); expect(t.remain_drtn_hr_cnt).toBe(40);
    expect(t.act_start_date).toBeNull(); expect(t.early_start_date).toBeNull();
    expect(t.s('guid')).not.toBe(s.taskByCode('A1000')!.s('guid'));
    expect(t.s('create_user')).toBe('admin');
    const t2 = s.addActivity({ task_name: 'Second', wbs_id: root });
    expect(t2.task_id).toBe(1338403); expect(t2.task_code).toBe('A1020');
    // row fits its field list and the file still parses
    expect(t.row.length).toBeLessThanOrEqual(s.T.TASK.fields.length);
    const again = parseXer(serializeXer(s.xer));
    expect(again.tables.find((x) => x.name === 'TASK')!.rows.length).toBe(3);
  });

  it('validates codes, milestones and constraints', () => {
    const s = load();
    const root = s.wbsRoot()!.wbs_id;
    expect(() => s.addActivity({ task_name: 'dup', wbs_id: root, task_code: 'A1000' })).toThrow(/already exists/);
    expect(() => s.addActivity({ task_name: 'x', wbs_id: 99 })).toThrow(/WBS 99/);
    const m = s.addActivity({ task_name: 'MS', wbs_id: root, task_type: 'TT_FinMile', target_drtn_hr_cnt: 40 });
    expect(m.target_drtn_hr_cnt).toBe(0);
    expect(() => s.updateActivity(m.task_id, { target_drtn_hr_cnt: 8 })).toThrow(/milestone/);
    expect(() => s.updateActivity(m.task_id, { cstr_type: 'CS_MSOA', cstr_date: 0 })).toThrow(/finish milestone/);
    expect(() => s.updateActivity(m.task_id, { cstr_type: 'CS_MEOB' })).toThrow(/needs a date/);
  });

  it('relationships: validation and cascade on delete', () => {
    const s = load();
    const root = s.wbsRoot()!.wbs_id;
    const a = s.taskByCode('A1000')!;
    const b = s.addActivity({ task_name: 'B', wbs_id: root });
    const r = s.addRelationship({ pred_task_id: a.task_id, task_id: b.task_id, lag_hr_cnt: 8 });
    expect(r.task_pred_id).toBe(1);
    expect(r.s('proj_id')).toBe(String(b.proj_id)); expect(r.s('pred_proj_id')).toBe(String(a.proj_id));
    expect(() => s.addRelationship({ pred_task_id: a.task_id, task_id: b.task_id })).toThrow(/already exists/);
    expect(() => s.addRelationship({ pred_task_id: a.task_id, task_id: a.task_id })).toThrow(/own predecessor/);
    s.addRelationship({ pred_task_id: a.task_id, task_id: b.task_id, pred_type: 'PR_SS' });
    expect(s.predsOf(b.task_id).length).toBe(2);
    expect(s.updateRelationship(r.task_pred_id, { lag_hr_cnt: 16 })[0]!.to).toBe('16');
    expect(() => s.updateRelationship(r.task_pred_id, { pred_type: 'PR_SS' })).toThrow(/already exists/);
    const removed = s.deleteActivity(b.task_id);
    expect(removed).toEqual([{ table: 'TASKPRED', removed: 2 }, { table: 'TASK', removed: 1 }]);
    expect(s.rels().length).toBe(0);
    expect(s.tasks().length).toBe(1);
  });

  it('adds WBS nodes', () => {
    const s = load();
    const root = s.wbsRoot()!;
    const w = s.addWbs({ wbs_name: 'Sitework', wbs_short_name: 'SW', parent_wbs_id: root.wbs_id });
    expect(w.parent_wbs_id).toBe(root.wbs_id);
    expect(s.wbsPath(w.wbs_id)).toBe('TEST.SW');
    expect(s.wbsDescendants(root.wbs_id)).toEqual([root.wbs_id, w.wbs_id]);
    expect(s.wbsByShortName('sw')!.wbs_id).toBe(w.wbs_id);
  });
});
