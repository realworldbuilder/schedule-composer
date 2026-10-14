import http from 'node:http';
import path from 'node:path';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Document } from './lib/state.ts';
import { blankProject } from './lib/schedule/blank.ts';
import { AgentSession, type ChatEvent } from './lib/agent/session.ts';
import type { Patch } from './lib/schedule/diff.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4400);
const HOST = process.env.HOST || '0.0.0.0';
const SAMPLES = path.join(HERE, 'samples');
const DATA = path.join(HERE, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const EXPORTS = path.join(DATA, 'exports');
const AGENT_CWD = path.join(DATA, 'agent');
const DIST = path.join(HERE, 'dist');
await mkdir(UPLOADS, { recursive: true }); await mkdir(EXPORTS, { recursive: true }); await mkdir(AGENT_CWD, { recursive: true });

const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

// ---- state ------------------------------------------------------------------------------
let doc: Document | null = null;
const session = new AgentSession({ doc: () => doc, exportDir: EXPORTS, cwd: AGENT_CWD, model: process.env.SC_MODEL, useApiKey: process.env.SC_USE_API_KEY === '1', log });

// ---- realtime --------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();
function broadcast(obj: unknown) { const s = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s); }
session.on('chat', (ev: ChatEvent) => broadcast({ type: 'chat', ev }));

async function openFile(file: string, bytes: Uint8Array) {
  const d = new Document(file, bytes);
  d.on('patch', (p: Patch) => broadcast({ type: 'patch', patch: p }));
  doc = d;
  session.reset();
  log(`opened ${file}: ${d.snapshot().tasks.length} activities, finish ${d.snapshot().project.finish}, cpm ${d.cpm.ms}ms`);
  broadcast({ type: 'snapshot', snapshot: d.snapshot() });
  return d;
}

async function listFiles() {
  const out: { name: string; path: string; size: number; mtime: string }[] = [];
  for (const dir of [SAMPLES, UPLOADS]) {
    let names: string[] = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.xer')) continue;
      const st = await stat(path.join(dir, n));
      out.push({ name: n, path: `${path.basename(dir)}/${n}`, size: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function resolveListed(p: string): string {
  const [dir, ...rest] = p.split('/');
  const base = dir === 'samples' ? SAMPLES : dir === 'uploads' ? UPLOADS : null;
  if (!base || rest.length !== 1 || !rest[0] || rest[0].includes('..')) throw new Error('bad path');
  return path.join(base, rest[0]);
}

// ---- http ----------------------------------------------------------------------------------
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.map': 'application/json' };
function json(res: http.ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
async function body(req: http.IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); return Buffer.concat(chunks); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, file: doc?.file ?? null, tasks: doc?.snapshot().tasks.length ?? 0, agent: session.authMode, model: session.model ?? 'default', session: session.sessionId });
    if (p === '/api/model' && req.method === 'POST') { const { model } = JSON.parse((await body(req)).toString('utf8') || '{}'); session.setModel(model); return json(res, 200, { model: session.model ?? 'default' }); }
    if (p === '/api/snapshot') return doc ? json(res, 200, doc.snapshot()) : json(res, 404, { error: 'no file open' });
    if (p === '/api/files') return json(res, 200, { files: await listFiles() });
    if (p === '/api/open' && req.method === 'POST') {
      const { path: rel } = JSON.parse((await body(req)).toString('utf8') || '{}');
      const full = resolveListed(rel);
      const d = await openFile(path.basename(full), new Uint8Array(await readFile(full)));
      return json(res, 200, d.snapshot());
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const name = String(req.headers['x-filename'] ?? 'upload.xer').replace(/[^\w.-]+/g, '_').replace(/\.xer$/i, '') + '.xer';
      const bytes = await body(req);
      await writeFile(path.join(UPLOADS, name), bytes);
      const d = await openFile(name, new Uint8Array(bytes));
      return json(res, 200, d.snapshot());
    }
    if (p === '/api/new' && req.method === 'POST') {
      const o = JSON.parse((await body(req)).toString('utf8') || '{}');
      if (!o.name || !o.start) return json(res, 400, { error: 'name and start are required' });
      const { file, bytes } = blankProject({ name: String(o.name), code: o.code ? String(o.code) : undefined, start: String(o.start), hoursPerDay: o.hoursPerDay ? Number(o.hoursPerDay) : undefined, workDays: Array.isArray(o.workDays) ? o.workDays.map(Number) : undefined }, new Uint8Array(await readFile(path.join(SAMPLES, 'PredecessorCalendar.xer'))));
      await writeFile(path.join(UPLOADS, file), bytes);
      const d = await openFile(file, bytes);
      return json(res, 200, d.snapshot());
    }
    if (p === '/api/export') {
      if (!doc) return json(res, 404, { error: 'no file open' });
      const name = doc.exportName(url.searchParams.get('name') || undefined);
      const bytes = doc.exportBytes();
      await writeFile(path.join(EXPORTS, name), bytes);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'content-length': bytes.length });
      return res.end(bytes);
    }
    if (p === '/api/undo' && req.method === 'POST') { if (!doc) return json(res, 404, { error: 'no file open' }); const { steps } = JSON.parse((await body(req)).toString('utf8') || '{}'); return json(res, 200, doc.undo('ui', { steps: steps ?? 1 })); }
    if (p === '/api/redo' && req.method === 'POST') { if (!doc) return json(res, 404, { error: 'no file open' }); return json(res, 200, doc.redo('ui')); }
    if (p === '/api/history') return json(res, 200, { undo: doc?.history.map((h) => h.label) ?? [], redo: doc?.redoStack.map((h) => h.label) ?? [] });
    if (p === '/api/chat' && req.method === 'POST') { const { text } = JSON.parse((await body(req)).toString('utf8') || '{}'); if (!text) return json(res, 400, { error: 'text required' }); return json(res, 200, { turn: session.send(String(text)) }); }
    if (p === '/api/interrupt' && req.method === 'POST') { await session.interrupt(); return json(res, 200, { ok: true }); }
    if (p === '/api/transcript') return json(res, 200, { events: session.transcript });
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    // static
    let file = path.join(DIST, p === '/' ? 'index.html' : p);
    if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
    try { await stat(file); } catch { file = path.join(DIST, 'index.html'); }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404); res.end('No UI build. Run `pnpm build`, or use `pnpm dev` on port 5174.'); }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`error ${req.method} ${p}: ${msg}`);
    json(res, 400, { error: msg });
  }
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    if (doc) ws.send(JSON.stringify({ type: 'snapshot', snapshot: doc.snapshot() }));
    ws.send(JSON.stringify({ type: 'chat', ev: { kind: 'status', working: false } }));
    for (const ev of session.transcript.slice(-200)) ws.send(JSON.stringify({ type: 'chat', ev }));
    ws.on('message', async (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'chat' && typeof m.text === 'string' && m.text.trim()) session.send(m.text);
        else if (m.type === 'interrupt') await session.interrupt();
      } catch (e) { ws.send(JSON.stringify({ type: 'error', message: e instanceof Error ? e.message : String(e) })); }
    });
    ws.on('close', () => clients.delete(ws));
  });
});

// Open a default file so the first visit has something to look at.
const initial = process.env.SC_OPEN || 'samples/generated-200.xer';
try { await openFile(path.basename(initial), new Uint8Array(await readFile(path.join(HERE, initial)))); } catch (e) { log(`could not open ${initial}: ${(e as Error).message}`); }

server.listen(PORT, HOST, () => log(`Schedule Composer on http://${HOST}:${PORT} (agent: ${session.authMode})`));
