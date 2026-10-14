// WebSocket client for /ws with 1 s, 2 s, 5 s reconnect backoff.
import type { Patch, Snapshot } from '../lib/schedule/diff.ts';
import { applyPatch, chatEvent, fail, loadSnapshot, resetChat, setOnline, setSender, setSnapshot, type ChatEvent } from './store';

type ServerMsg =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'patch'; patch: Patch }
  | { type: 'chat'; ev: ChatEvent }
  | { type: 'error'; message: string };

const BACKOFF = [1000, 2000, 5000];
let sock: WebSocket | null = null;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let gotSnapshot = false;

export function connect(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  sock = ws;
  gotSnapshot = false;
  ws.onopen = () => {
    attempt = 0;
    resetChat();
    setOnline(true);
    // The server sends a snapshot on connect only when a file is open; ask over HTTP
    // too so a 404 turns into the "No schedule open" state instead of silence.
    setTimeout(() => { if (!gotSnapshot) loadSnapshot().catch(() => {}); }, 400);
  };
  ws.onmessage = (e) => {
    let msg: ServerMsg;
    try { msg = JSON.parse(String(e.data)) as ServerMsg; } catch { return; }
    switch (msg.type) {
      case 'snapshot': gotSnapshot = true; setSnapshot(msg.snapshot); break;
      case 'patch': applyPatch(msg.patch); break;
      case 'chat': chatEvent(msg.ev); break;
      case 'error': fail(msg.message); break;
    }
  };
  ws.onclose = () => {
    if (sock !== ws) return;
    sock = null;
    setOnline(false);
    const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)]!;
    attempt++;
    timer = setTimeout(connect, delay);
  };
  ws.onerror = () => { ws.close(); };
}

setSender((msg) => {
  if (!sock || sock.readyState !== WebSocket.OPEN) return false;
  sock.send(JSON.stringify(msg));
  return true;
});
