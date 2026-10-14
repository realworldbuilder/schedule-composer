// Generates samples/generated-200.xer: a believable commercial-build schedule seeded from the MPXJ sample.
// Usage: node tools/sample.mjs [--tasks 5000] [--out samples/x.xer]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseXer } from '../lib/xer/parse.ts';
import { serializeXer } from '../lib/xer/serialize.ts';
import { Schedule } from '../lib/schedule/model.ts';
import { runCpm, applyCpm } from '../lib/schedule/cpm.ts';
import { parseP6Date, fmtP6Date } from '../lib/schedule/dates.ts';
import { workHoursBetween } from '../lib/schedule/calendar.ts';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const TARGET = +opt('--tasks', 200);
const OUT = opt('--out', TARGET === 200 ? 'samples/generated-200.xer' : `samples/generated-${TARGET}.xer`);
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const xer = parseXer(new Uint8Array(readFileSync('samples/PredecessorCalendar.xer')));
const s = new Schedule(xer);
const P = s.project;
P.set('proj_short_name', 'RWB-TOWER'); P.set('task_code_prefix', 'A'); P.set('task_code_base', '1000'); P.set('task_code_step', '10');
const PLAN_START = parseP6Date('2025-11-03 08:00');
P.setDate('plan_start_date', PLAN_START); P.setDate('last_recalc_date', parseP6Date('2025-11-03 00:00')); P.set('plan_end_date', '');
s.deleteActivity(s.taskByCode('A1000').task_id);
const root = s.wbsRoot();
root.set('wbs_short_name', 'RWB'); root.set('wbs_name', 'RWB Tower - 12 Storey Office');
s.touch();

const H = 8; // hours per day
const phases = [
  ['PRE', 'Preconstruction', ['Permit Submission', 'Permit Approval', 'Mobilization', 'Temporary Power', 'Site Fence & Signage', 'Survey & Layout', 'SWPPP Install']],
  ['SITE', 'Sitework', ['Clear & Grub', 'Mass Excavation', 'Export Spoils', 'Storm Drainage', 'Sanitary Sewer', 'Water Main', 'Site Electrical Duct Bank', 'Rough Grading']],
  ['FND', 'Foundations', ['Drilled Piers', 'Pier Caps', 'Grade Beams', 'Underslab MEP', 'Slab on Grade Pour 1', 'Slab on Grade Pour 2', 'Elevator Pit', 'Waterproofing']],
  ['STR', 'Structure', ['Columns L1', 'Deck L2', 'Columns L2', 'Deck L3', 'Columns L3', 'Deck L4', 'Columns L4', 'Deck L5', 'Columns L5', 'Deck L6', 'Columns L6', 'Deck L7', 'Columns L7', 'Deck L8', 'Columns L8', 'Deck L9', 'Columns L9', 'Deck L10', 'Columns L10', 'Deck L11', 'Columns L11', 'Deck L12', 'Roof Deck', 'Stair Towers', 'Elevator Hoistway']],
  ['ENV', 'Envelope', ['Curtain Wall Shop Drawings', 'Curtain Wall Fabrication', 'Curtain Wall East', 'Curtain Wall South', 'Curtain Wall West', 'Curtain Wall North', 'Roofing', 'Roof Screens', 'Louvers', 'Exterior Sealants', 'Canopy Steel', 'Canopy Glazing']],
  ['MEP', 'MEP Rough-in', ['Fire Protection Mains', 'HVAC Risers', 'Plumbing Risers', 'Electrical Risers', 'Overhead Rough L1-3', 'Overhead Rough L4-6', 'Overhead Rough L7-9', 'Overhead Rough L10-12', 'In-wall Rough L1-3', 'In-wall Rough L4-6', 'In-wall Rough L7-9', 'In-wall Rough L10-12', 'Switchgear Set', 'Generator Set', 'AHU Set', 'Chiller Set', 'Cooling Tower']],
  ['INT', 'Interiors', ['Framing L1-3', 'Framing L4-6', 'Framing L7-9', 'Framing L10-12', 'Drywall L1-3', 'Drywall L4-6', 'Drywall L7-9', 'Drywall L10-12', 'Ceilings L1-3', 'Ceilings L4-6', 'Ceilings L7-9', 'Ceilings L10-12', 'Paint L1-3', 'Paint L4-6', 'Paint L7-9', 'Paint L10-12', 'Flooring L1-3', 'Flooring L4-6', 'Flooring L7-9', 'Flooring L10-12', 'Millwork', 'Restroom Finishes', 'Lobby Stone', 'Elevator Cabs', 'Doors & Hardware']],
  ['CLO', 'Closeout', ['MEP Trim', 'Fixtures & Devices', 'Test & Balance', 'Fire Alarm Test', 'Elevator Inspection', 'Life Safety Inspection', 'Punch List', 'Final Clean', 'Owner Training', 'As-builts & O&M']],
];
const dur = (name) => {
  if (/Approval|Fabrication/.test(name)) return 30 * H;
  if (/Deck|Columns/.test(name)) return 7 * H;
  if (/Inspection|Test|Set$|Pour/.test(name)) return 3 * H;
  if (/Punch|Clean|Training|As-builts/.test(name)) return 10 * H;
  return (5 + Math.floor(rnd() * 11)) * H;
};

const wbsIds = {};
for (const [code, name] of phases) wbsIds[code] = s.addWbs({ wbs_name: name, wbs_short_name: code, parent_wbs_id: root.wbs_id }).wbs_id;
const MS = s.addWbs({ wbs_name: 'Milestones', wbs_short_name: 'MS', parent_wbs_id: root.wbs_id }).wbs_id;

const ntp = s.addActivity({ task_name: 'Notice to Proceed', wbs_id: MS, task_type: 'TT_Mile', cstr_type: 'CS_MSOA', cstr_date: PLAN_START });
const topping = s.addActivity({ task_name: 'Topping Out', wbs_id: MS, task_type: 'TT_FinMile' });
const dryIn = s.addActivity({ task_name: 'Building Dry-In', wbs_id: MS, task_type: 'TT_FinMile' });
const subst = s.addActivity({ task_name: 'Substantial Completion', wbs_id: MS, task_type: 'TT_FinMile', cstr_type: 'CS_MEOB', cstr_date: parseP6Date('2027-06-30 17:00') });

const byPhase = {};
for (const [code, , names] of phases) {
  const list = [];
  for (const n of names) list.push(s.addActivity({ task_name: n, wbs_id: wbsIds[code], target_drtn_hr_cnt: dur(n) }));
  byPhase[code] = list;
}
// Pad to TARGET with per-floor repeated work.
let extra = TARGET - s.tasks().length;
const floors = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12'];
const trades = ['Fireproofing', 'Insulation', 'Window Blinds', 'Signage', 'Low Voltage Cabling', 'Access Control', 'Casework', 'Carpet Tile', 'Light Fixtures', 'Diffusers & Grilles'];
const pad = [];
for (let i = 0; extra > 0; i++, extra--) {
  const name = `${trades[i % trades.length]} ${floors[Math.floor(i / trades.length) % floors.length]}${i >= trades.length * floors.length ? ' #' + Math.floor(i / (trades.length * floors.length)) : ''}`;
  pad.push(s.addActivity({ task_name: name, wbs_id: i % 2 ? wbsIds.INT : wbsIds.MEP, target_drtn_hr_cnt: (3 + Math.floor(rnd() * 8)) * H }));
}

const rel = (p, c, type = 'PR_FS', lag = 0) => s.addRelationship({ pred_task_id: p.task_id, task_id: c.task_id, pred_type: type, lag_hr_cnt: lag });
const chain = (list, overlap = 0) => { for (let i = 1; i < list.length; i++) { if (overlap && rnd() < overlap) rel(list[i - 1], list[i], 'PR_SS', 2 * H); else rel(list[i - 1], list[i]); } };

// Preconstruction: permit path and site setup in parallel.
const [permitSub, permitApp, mob, tempPower, fence, survey, swppp] = byPhase.PRE;
rel(ntp, permitSub); rel(permitSub, permitApp); rel(ntp, mob); rel(mob, tempPower); rel(mob, fence); rel(mob, survey); rel(mob, swppp);
// Sitework after permit + survey.
chain(byPhase.SITE, 0.3); rel(permitApp, byPhase.SITE[0]); rel(survey, byPhase.SITE[0]); rel(swppp, byPhase.SITE[0]);
// Foundations after excavation.
chain(byPhase.FND, 0.2); rel(byPhase.SITE[1], byPhase.FND[0], 'PR_FS', 2 * H); rel(byPhase.SITE[3], byPhase.FND[3]);
// Structure: strictly sequential floor cycle after slab pour 1 and elevator pit.
chain(byPhase.STR.slice(0, 23)); rel(byPhase.FND[4], byPhase.STR[0]); rel(byPhase.FND[6], byPhase.STR[0]);
rel(byPhase.STR[22], topping); rel(byPhase.STR[1], byPhase.STR[23], 'PR_SS', 5 * H); rel(byPhase.STR[22], byPhase.STR[23], 'PR_FF'); rel(byPhase.STR[1], byPhase.STR[24], 'PR_SS'); rel(byPhase.STR[22], byPhase.STR[24], 'PR_FF', 5 * H);
// Envelope: shop drawings early, install after structure, roofing after roof deck.
const E = byPhase.ENV;
rel(ntp, E[0]); rel(E[0], E[1]); rel(E[1], E[2]); chain(E.slice(2, 6)); rel(byPhase.STR[21], E[2]);
rel(byPhase.STR[22], E[6]); rel(E[6], E[7]); rel(E[7], E[8]); rel(E[5], E[9]); rel(E[8], E[9], 'PR_FF'); rel(byPhase.STR[1], E[10], 'PR_FS', 20 * H); rel(E[10], E[11]);
rel(E[9], dryIn); rel(E[6], dryIn);
// MEP: risers after structure topping, overhead per zone follows structure with lag, equipment sets.
const M = byPhase.MEP;
rel(byPhase.STR[22], M[0]); chain(M.slice(0, 4), 0.5);
rel(byPhase.STR[5], M[4], 'PR_FS', 5 * H); rel(byPhase.STR[11], M[5], 'PR_FS', 5 * H); rel(byPhase.STR[17], M[6], 'PR_FS', 5 * H); rel(byPhase.STR[21], M[7], 'PR_FS', 5 * H);
for (let z = 0; z < 4; z++) { rel(M[4 + z], M[8 + z], 'PR_SS', 5 * H); rel(M[4 + z], M[8 + z], 'PR_FF', 3 * H); }
rel(M[3], M[12]); rel(M[12], M[13]); rel(byPhase.STR[22], M[14]); rel(M[14], M[15]); rel(M[15], M[16]);
// Interiors: framing per zone after in-wall rough; the classic finish chain.
const I = byPhase.INT;
for (let z = 0; z < 4; z++) {
  rel(M[8 + z], I[z], 'PR_SS', 5 * H); rel(M[8 + z], I[z], 'PR_FF', 2 * H); rel(dryIn, I[4 + z]);
  rel(I[z], I[4 + z]); rel(I[4 + z], I[8 + z]); rel(I[8 + z], I[12 + z]); rel(I[12 + z], I[16 + z]);
}
rel(I[19], I[20]); rel(I[19], I[21], 'PR_SS'); rel(I[16], I[22]); rel(byPhase.STR[24], I[23]); rel(I[15], I[24], 'PR_SS', 10 * H);
// Padding tasks hang off zone work with float.
pad.forEach((t, i) => { const z = i % 4; rel(I[8 + z], t, 'PR_SS', (i % 5) * H); rel(t, I[16 + z], 'PR_FS'); });
// Closeout.
const C = byPhase.CLO;
rel(I[19], C[0]); rel(I[23], C[4]); rel(M[16], C[2], 'PR_FS', 10 * H); rel(C[0], C[1]); rel(C[1], C[2]); rel(C[1], C[3]); rel(C[2], C[5]); rel(C[3], C[5]); rel(C[4], C[5]);
rel(C[5], C[6]); rel(I[20], C[6]); rel(I[21], C[6]); rel(I[22], C[6]); rel(I[24], C[6]); rel(C[6], C[7]); rel(C[7], subst); rel(C[5], C[8]); rel(C[8], subst, 'PR_FF'); rel(C[0], C[9], 'PR_SS'); rel(C[9], subst, 'PR_FF');
// A couple of open-ended items on purpose (for check_logic to find).
rel(tempPower, fence, 'PR_SS');

// Schedule once from plan start, then set progress relative to a data date 5 months in.
let r = runCpm(s); applyCpm(s, r);
const DATA_DATE = parseP6Date('2026-04-06 00:00');
for (const t of s.tasks()) {
  const n = r.nodes.get(t.task_id); if (!n) continue;
  const cal = s.calendarFor(t);
  if (n.ef <= DATA_DATE) {
    t.set('status_code', 'TK_Complete'); t.setDate('act_start_date', n.es); t.setDate('act_end_date', n.ef); t.setHours('remain_drtn_hr_cnt', 0); t.set('phys_complete_pct', '100');
  } else if (n.es < DATA_DATE) {
    const remain = Math.max(1, Math.round(workHoursBetween(cal, DATA_DATE, n.ef)));
    t.set('status_code', 'TK_Active'); t.setDate('act_start_date', n.es); t.setHours('remain_drtn_hr_cnt', remain);
    t.set('phys_complete_pct', String(Math.round(100 * (1 - remain / Math.max(1, t.target_drtn_hr_cnt)))));
  }
}
P.setDate('last_recalc_date', DATA_DATE);
s.touch();
r = runCpm(s); applyCpm(s, r);
writeFileSync(OUT, serializeXer(s.xer));
const st = { NotStart: 0, Active: 0, Complete: 0 }; for (const t of s.tasks()) st[t.status_code.slice(3)]++;
console.log(`${OUT}: ${s.tasks().length} activities, ${s.rels().length} relationships, data date ${fmtP6Date(r.dataDate)}, finish ${fmtP6Date(r.finish)}, cpm ${r.ms}ms, status`, st, 'warnings', r.warnings);
