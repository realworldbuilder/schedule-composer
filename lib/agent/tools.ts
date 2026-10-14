// Agent SDK wrapper around the provider-neutral handlers (server / Max-login mode).
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { TOOL_SPECS, runTool, type ToolCtx } from './handlers.ts';
export { handlers, TOOL_SPECS, runTool, READ_TOOLS, type ToolCtx, type ToolName } from './handlers.ts';

export function makeSchedServer(ctx: ToolCtx) {
  const tools = TOOL_SPECS.map((t) => tool(t.name, t.description, t.shape, async (args) => runTool(ctx, t.name, args), { annotations: { readOnlyHint: t.readOnly }, alwaysLoad: true }));
  return createSdkMcpServer({ name: 'sched', version: '1.0.0', tools, alwaysLoad: true });
}
