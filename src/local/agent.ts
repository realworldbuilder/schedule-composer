// In-browser agent: the Anthropic Messages API with the same sched tools the server uses,
// driven as a manual tool loop so every tool call streams to the chat as it happens.
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from '../../lib/agent/prompt.ts';
import { runTool, toolJsonSchemas, type ToolCtx } from '../../lib/agent/handlers.ts';
import type { CompactDiff } from '../../lib/schedule/diff.ts';
import type { Document } from '../../lib/state.ts';

export type ChatEvent =
  | { kind: 'user'; turn: string; text: string }
  | { kind: 'status'; working: boolean }
  | { kind: 'text'; turn: string; delta: string }
  | { kind: 'tool_start'; turn: string; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; turn: string; id: string; name: string; ok: boolean; summary: string; diff?: CompactDiff; data?: unknown }
  | { kind: 'turn_end'; turn: string; ok: boolean; error?: string; cost_usd?: number; duration_ms?: number; num_turns?: number };

export interface AgentOptions {
  apiKey: () => string;
  model: () => string;
  effort: () => '' | 'low' | 'medium' | 'high' | 'xhigh';
  doc: () => Document | null;
  emit: (ev: ChatEvent) => void;
  cost: (model: string, inTok: number, outTok: number) => number;
  saveExport: ToolCtx['saveExport'];
  /** Test hook: point the client at a mock server. */
  baseURL?: string;
}

const MAX_STEPS = 40;

export class LocalAgent {
  private history: Anthropic.MessageParam[] = [];
  private queue: { turn: string; text: string }[] = [];
  private busy = false;
  private abort: AbortController | null = null;
  private opts: AgentOptions;
  private introduced = false;

  constructor(opts: AgentOptions) { this.opts = opts; }

  send(text: string): string {
    const turn = Math.random().toString(16).slice(2, 10);
    this.queue.push({ turn, text });
    this.opts.emit({ kind: 'user', turn, text });
    void this.pump();
    return turn;
  }

  interrupt(): void { this.queue.length = 0; this.abort?.abort(); }
  reset(): void { this.history = []; this.introduced = false; }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    this.opts.emit({ kind: 'status', working: true });
    try { while (this.queue.length) { const { turn, text } = this.queue.shift()!; await this.runTurn(turn, text); } }
    finally { this.busy = false; this.opts.emit({ kind: 'status', working: false }); }
  }

  private async runTurn(turn: string, text: string) {
    const { emit } = this.opts;
    const doc = this.opts.doc();
    const t0 = Date.now();
    if (!doc) { emit({ kind: 'turn_end', turn, ok: false, error: 'No schedule is open. Open an XER file or start a new project first.' }); return; }
    const apiKey = this.opts.apiKey();
    if (!apiKey) { emit({ kind: 'turn_end', turn, ok: false, error: 'No API key. Click "API key" in the top bar and paste an Anthropic key.' }); return; }
    const model = this.opts.model();
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...(this.opts.baseURL ? { baseURL: this.opts.baseURL } : {}) });
    const ctx: ToolCtx = { doc: () => { const d = this.opts.doc(); if (!d) throw new Error('no schedule open'); return d; }, turn: () => turn, saveExport: this.opts.saveExport };
    const snap = doc.snapshot();
    const preface = this.introduced ? '' : `Open schedule: ${doc.file} (${snap.tasks.length} activities, data date ${snap.project.dataDate}, finish ${snap.project.finish}).\n\n`;
    this.introduced = true;
    this.history.push({ role: 'user', content: preface + text });
    const tools = toolJsonSchemas().map((t) => ({ ...t, input_schema: t.input_schema as Anthropic.Tool['input_schema'] }));
    const effort = this.opts.effort();
    let inTok = 0, outTok = 0, steps = 0;
    this.abort = new AbortController();
    try {
      for (let i = 0; i < MAX_STEPS; i++) {
        steps++;
        const stream = client.messages.stream({
          model, max_tokens: 16000,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools, messages: this.history,
          ...(effort ? { output_config: { effort } } : {}),
        }, { signal: this.abort.signal });
        stream.on('streamEvent', (ev) => {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') emit({ kind: 'tool_start', turn, id: ev.content_block.id, name: ev.content_block.name, input: null });
        });
        stream.on('text', (delta) => emit({ kind: 'text', turn, delta }));
        const msg = await stream.finalMessage();
        inTok += msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
        outTok += msg.usage.output_tokens;
        this.history.push({ role: 'assistant', content: msg.content });
        if (msg.stop_reason === 'refusal') throw new Error('The model declined this request.');
        if (msg.stop_reason === 'max_tokens') { emit({ kind: 'text', turn, delta: '\n\n_(response cut off at the token limit)_' }); break; }
        const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (msg.stop_reason !== 'tool_use' || uses.length === 0) break;
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const u of uses) {
          emit({ kind: 'tool_start', turn, id: u.id, name: u.name, input: u.input });
          const r = await runTool(ctx, u.name, u.input);
          const textOut = r.content.map((c) => c.text).join('');
          let parsed: { summary?: string; diff?: CompactDiff; data?: unknown; error?: string } = {};
          try { parsed = JSON.parse(textOut); } catch { parsed = { summary: textOut.slice(0, 300) }; }
          emit({ kind: 'tool_result', turn, id: u.id, name: u.name, ok: !r.isError && !parsed.error, summary: parsed.error ?? parsed.summary ?? '', diff: parsed.diff, data: parsed.data });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: textOut, is_error: r.isError });
        }
        this.history.push({ role: 'user', content: results });
      }
      emit({ kind: 'turn_end', turn, ok: true, cost_usd: this.opts.cost(model, inTok, outTok), duration_ms: Date.now() - t0, num_turns: steps });
    } catch (e) {
      // Keep the history consistent: drop a dangling user turn so the next request is valid.
      const last = this.history[this.history.length - 1];
      if (last && last.role === 'user') this.history.pop();
      const aborted = this.abort?.signal.aborted;
      let msg = aborted ? 'stopped' : e instanceof Error ? e.message : String(e);
      if (e instanceof Anthropic.AuthenticationError) msg = 'The API key was rejected. Check it under "API key".';
      else if (e instanceof Anthropic.RateLimitError) msg = 'Rate limited by the API; try again in a moment.';
      else if (e instanceof Anthropic.APIError) msg = `API error ${e.status ?? ''}: ${e.message}`;
      emit({ kind: 'turn_end', turn, ok: false, error: msg, cost_usd: this.opts.cost(model, inTok, outTok), duration_ms: Date.now() - t0, num_turns: steps });
    } finally { this.abort = null; }
  }
}
