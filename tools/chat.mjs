// Smoke-test the agent from the terminal: node tools/chat.mjs "add a 10-day activity after A1010"
import WebSocket from 'ws';
const text = process.argv.slice(2).join(' ') || 'Give me a one-paragraph summary of this schedule.';
const url = process.env.SC_URL || 'ws://127.0.0.1:4400/ws';
const ws = new WebSocket(url);
let myTurn = null; let gotSnapshot = false;
ws.on('open', () => { ws.send(JSON.stringify({ type: 'chat', text })); });
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'snapshot') { gotSnapshot = true; return; }
  if (m.type === 'chat' && m.ev.kind === 'user' && m.ev.text === text && !myTurn) { myTurn = m.ev.turn; console.log(`> ${text}`); return; }
  if (!myTurn) return; // replayed history from before our message
  if (m.type === 'patch') { console.log(`  [patch] ${m.patch.label}: ${m.patch.ops.length} ops, finish ${m.patch.ops.find((o) => o.op === 'project')?.project.finish ?? '(same)'}`); return; }
  if (m.type !== 'chat') { console.log(m); return; }
  const ev = m.ev;
  if (ev.turn && ev.turn !== myTurn) return;
  if (ev.kind === 'text') process.stdout.write(ev.delta);
  else if (ev.kind === 'tool_start' && ev.input !== null) console.log(`\n  [tool] ${ev.name} ${JSON.stringify(ev.input).slice(0, 200)}`);
  else if (ev.kind === 'tool_result') console.log(`  [${ev.ok ? 'ok' : 'ERR'}] ${ev.name}: ${ev.summary.slice(0, 300)}`);
  else if (ev.kind === 'turn_end') { console.log(`\n  [end] ok=${ev.ok} ${ev.error ?? ''} cost=$${ev.cost_usd ?? '?'} ${ev.duration_ms ?? '?'}ms turns=${ev.num_turns ?? '?'}`); ws.close(); process.exit(ev.ok ? 0 : 1); }
});
ws.on('error', (e) => { console.error('ws error', e.message); process.exit(2); });
setTimeout(() => { console.error('timeout'); process.exit(3); }, 600_000);
