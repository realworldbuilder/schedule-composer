import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SYSTEM_PROMPT } from './prompt.ts';
import { makeSchedServer, handlers, type ToolCtx } from './tools.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { CompactDiff } from '../schedule/diff.ts';
import type { Document } from '../state.ts';

export type ChatEvent =
  | { kind: 'user'; turn: string; text: string }
  | { kind: 'status'; working: boolean }
  | { kind: 'text'; turn: string; delta: string }
  | { kind: 'tool_start'; turn: string; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; turn: string; id: string; name: string; ok: boolean; summary: string; diff?: CompactDiff; data?: unknown }
  | { kind: 'turn_end'; turn: string; ok: boolean; error?: string; cost_usd?: number; duration_ms?: number; num_turns?: number };

export interface SessionOptions {
  doc: () => Document | null;
  exportDir: string;
  cwd: string;
  model?: string;
  useApiKey?: boolean;
  log?: (s: string) => void;
}

const TOOL_NAMES = Object.keys(handlers).map((n) => `mcp__sched__${n}`);

/** One chat conversation with the agent. Turns run one at a time; extra messages queue. */
export class AgentSession extends EventEmitter {
  sessionId: string | null = null;
  private running: Query | null = null;
  private queue: { turn: string; text: string }[] = [];
  private busy = false;
  readonly opts: SessionOptions;
  readonly transcript: ChatEvent[] = [];

  constructor(opts: SessionOptions) { super(); this.opts = opts; }

  get authMode(): 'api-key' | 'max-login' { return this.opts.useApiKey && process.env.ANTHROPIC_API_KEY ? 'api-key' : 'max-login'; }

  send(text: string): string {
    const turn = randomBytes(6).toString('hex');
    this.queue.push({ turn, text });
    this.ev({ kind: 'user', turn, text });
    void this.pump();
    return turn;
  }

  async interrupt(): Promise<void> {
    this.queue.length = 0;
    try { await this.running?.interrupt(); } catch { /* ignore */ }
  }

  reset(): void { this.sessionId = null; this.transcript.length = 0; }

  private ev(e: ChatEvent) { this.transcript.push(e); if (this.transcript.length > 2000) this.transcript.shift(); this.emit('chat', e); }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    this.ev({ kind: 'status', working: true });
    try {
      while (this.queue.length) {
        const { turn, text } = this.queue.shift()!;
        await this.runTurn(turn, text);
      }
    } finally {
      this.busy = false;
      this.ev({ kind: 'status', working: false });
    }
  }

  get model(): string | undefined { return this.opts.model; }
  setModel(m: string | undefined) { this.opts.model = m || undefined; }

  private async runTurn(turn: string, text: string, retried = false): Promise<void> {
    const log = this.opts.log ?? (() => {});
    const doc = this.opts.doc();
    if (!doc) { this.ev({ kind: 'turn_end', turn, ok: false, error: 'No schedule is open. Open an XER file first.' }); return; }
    const ctx: ToolCtx = { doc: () => { const d = this.opts.doc(); if (!d) throw new Error('no schedule open'); return d; }, turn: () => turn, saveExport: async (name, bytes) => { await mkdir(this.opts.exportDir, { recursive: true }); const p = path.join(this.opts.exportDir, name); await writeFile(p, bytes); return { path: p, bytes: bytes.length }; } };
    const env: Record<string, string | undefined> = { ...process.env };
    if (this.authMode === 'max-login') delete env.ANTHROPIC_API_KEY;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'schedule-composer/0.1';
    const preface = `Open schedule: ${doc.file} (${doc.snapshot().tasks.length} activities, data date ${doc.snapshot().project.dataDate}, finish ${doc.snapshot().project.finish}).`;
    const prompt = this.sessionId ? text : `${preface}\n\n${text}`;
    const q = query({
      prompt,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { sched: makeSchedServer(ctx) },
        tools: [],
        allowedTools: TOOL_NAMES,
        permissionMode: 'default',
        includePartialMessages: true,
        maxTurns: 60,
        cwd: this.opts.cwd,
        env,
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(this.sessionId ? { resume: this.sessionId } : {}),
      },
    });
    this.running = q;
    const toolNames = new Map<string, string>();
    let streamedText = 0;
    let ended = false;
    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        const m = msg as unknown as { type: string; [k: string]: unknown }; const any = m as unknown;
        if (m.type === 'system' && (m as { subtype?: string }).subtype === 'init') {
          this.sessionId = (any as { session_id: string }).session_id;
          log(`agent session ${this.sessionId} model ${(m as { model?: string }).model ?? '?'}`);
        } else if (m.type === 'stream_event') {
          const ev = (any as { event: { type: string; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; text?: string } } }).event;
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block.id) {
            const name = (ev.content_block.name ?? '').replace(/^mcp__sched__/, '');
            toolNames.set(ev.content_block.id, name);
            this.ev({ kind: 'tool_start', turn, id: ev.content_block.id, name, input: null });
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            streamedText += ev.delta.text.length;
            this.ev({ kind: 'text', turn, delta: ev.delta.text });
          }
        } else if (m.type === 'assistant') {
          const content = ((any as { message: { content: unknown[] } }).message?.content ?? []) as { type: string; id?: string; name?: string; input?: unknown; text?: string }[];
          for (const b of content) {
            if (b.type === 'tool_use' && b.id) {
              const name = (b.name ?? '').replace(/^mcp__sched__/, '');
              toolNames.set(b.id, name);
              this.ev({ kind: 'tool_start', turn, id: b.id, name, input: b.input ?? {} });
            } else if (b.type === 'text' && b.text && streamedText === 0) {
              this.ev({ kind: 'text', turn, delta: b.text });
            }
          }
          streamedText = 0;
        } else if (m.type === 'user') {
          const content = (m as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(content)) {
            for (const b of content as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
              if (b.type !== 'tool_result' || !b.tool_use_id) continue;
              const name = toolNames.get(b.tool_use_id) ?? 'tool';
              const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as { type: string; text?: string }[]).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('') : '';
              let parsed: { summary?: string; diff?: CompactDiff; data?: unknown; error?: string } = {};
              try { parsed = JSON.parse(text); } catch { parsed = { summary: text.slice(0, 300) }; }
              const ok = !b.is_error && !parsed.error;
              this.ev({ kind: 'tool_result', turn, id: b.tool_use_id, name, ok, summary: parsed.error ?? parsed.summary ?? '', diff: parsed.diff, data: parsed.data });
            }
          }
        } else if (m.type === 'result') {
          const r = any as { subtype: string; is_error?: boolean; result?: string; total_cost_usd?: number; duration_ms?: number; num_turns?: number; errors?: string[] };
          const ok = r.subtype === 'success' && !r.is_error;
          const error = ok ? undefined : (r.errors?.join('; ') || r.result || r.subtype);
          if (!ok && !retried && error && /limit|429|rate/i.test(error) && this.opts.model !== 'opus') {
            // Usage limit on the default model: fall back to Opus for the rest of this server run.
            log(`model limit hit (${error.slice(0, 80)}); falling back to opus`);
            this.opts.model = 'opus';
            this.ev({ kind: 'text', turn, delta: `_(usage limit on the default model; switching to Opus and retrying)_\n\n` });
            this.running = null; ended = true;
            return this.runTurn(turn, text, true);
          }
          this.ev({ kind: 'turn_end', turn, ok, error, cost_usd: r.total_cost_usd, duration_ms: r.duration_ms, num_turns: r.num_turns });
          ended = true;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`agent error: ${msg}`);
      if (!ended) this.ev({ kind: 'turn_end', turn, ok: false, error: msg });
      ended = true;
    } finally {
      this.running = null;
      if (!ended) this.ev({ kind: 'turn_end', turn, ok: false, error: 'turn ended without a result' });
    }
  }
}
