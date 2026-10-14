# Schedule Composer: server <-> browser protocol

Server: Node, port 4400 (`node server.ts`), binds 0.0.0.0. Dev UI: `pnpm dev` (Vite on 5174, proxies `/api` and `/ws` to 4400).
Types for every payload live in `lib/schedule/diff.ts` (`Snapshot`, `SnapTask`, `SnapRel`, `SnapWbs`, `SnapProject`, `Patch`, `PatchOp`, `CompactDiff`). The browser imports those types directly (type-only imports are fine for the Vite build).

Units: durations/floats/lags in **hours**; dates are `'YYYY-MM-DD HH:MM'` strings (wall clock, no timezone; parse with `Date.UTC`). Calendars list `dayHours` (usually 8) for hours -> days display.

## HTTP

| Route | What |
|---|---|
| `GET /api/health` | `{ ok, file, tasks, agent: 'max-login' \| 'api-key', model }` |
| `GET /api/snapshot` | current `Snapshot` (404 if no file open) |
| `GET /api/files` | `{ files: [{ name, path, size, mtime }] }` from `samples/` and `data/uploads/` |
| `POST /api/open` JSON `{ path }` | open one of the listed files; returns `Snapshot` and broadcasts it |
| `POST /api/upload` raw body, header `X-Filename: name.xer` | saves to `data/uploads/`, opens it, returns `Snapshot` |
| `POST /api/new` JSON `{ name, code?, start: 'YYYY-MM-DD', hoursPerDay?: 8, workDays?: [1,2,3,4,5] }` | creates a blank project (one root WBS, no activities) with a standard calendar (workDays 0=Sun..6=Sat, default Mon-Fri 08-12/13-17), opens it, returns `Snapshot`. The agent then builds the schedule from chat (`add_wbs`, `add_activities`, `add_relationships`). |
| `GET /api/export?name=` | XER download (`Content-Disposition: attachment`) |
| `POST /api/undo` `{ steps? }` / `POST /api/redo` | returns `CompactDiff`; patch is broadcast |
| `GET /api/history` | `{ undo: [labels...], redo: [labels...] }` |
| `POST /api/chat` `{ text }` | same as the WS `chat` message (returns `{ turn }`) |
| `POST /api/interrupt` | stops the running agent turn |
| `POST /api/model` `{ model }` | switch the agent model for later turns (`opus`, `sonnet`, a full id, or empty for the CLI default) |

## WebSocket `/ws`

Server -> client (JSON, one object per message):

- `{ type: 'snapshot', snapshot: Snapshot }` on connect and whenever a file is (re)opened.
- `{ type: 'patch', patch: Patch }` after every mutation (agent tool call, undo, redo). Apply `patch.ops` in order: `task` upserts a full `SnapTask` by id, `delete_task`, `rel` upserts a `SnapRel`, `delete_rel`, `wbs`, `delete_wbs`, `project` replaces the project header. `patch.label` is a short human label ("add_activity Punch List"), `patch.turn` the chat turn that caused it. Highlight the touched rows for ~3 s.
- `{ type: 'chat', ev: ChatEvent }` where `ChatEvent` is one of:
  - `{ kind: 'user', turn, text }` the user's message (echoed, so every tab sees it)
  - `{ kind: 'status', working: boolean }`
  - `{ kind: 'text', turn, delta }` streaming assistant text (append to the current assistant bubble)
  - `{ kind: 'tool_start', turn, id, name, input }` a tool call began (`name` without the `mcp__sched__` prefix, e.g. `add_activity`). **Sent twice per call**: first as soon as the model starts the call with `input: null`, then again with the full `input` once the call is complete. Upsert the card by `id`.
  - `{ kind: 'tool_result', turn, id, name, ok, summary, diff?: CompactDiff, data?: unknown }` tool finished; `summary` is one line; `diff` present for writes; `data` for reads (summary/search/trace results, can be large, render collapsed)
  - `{ kind: 'turn_end', turn, ok, error?, cost_usd?, duration_ms?, num_turns? }`
- `{ type: 'error', message }`

On connect the server sends `snapshot`, then `{ kind: 'status' }`, then **replays the last 200 chat events** of the current conversation so a reloaded tab shows the history. Rebuild the chat from them in order (they are the same events as live ones; `text` deltas of one turn concatenate).

Client -> server:

- `{ type: 'chat', text }` send a user message (one agent turn at a time; extra messages queue)
- `{ type: 'interrupt' }` stop the current turn

Tool names the agent has (for card icons/labels): reads `get_summary`, `search_activities`, `get_activity`, `list_wbs`, `trace_driving`, `check_logic`; writes `add_activity`, `add_activities` (bulk), `update_activities`, `delete_activities`, `add_relationships`, `update_relationships`, `delete_relationships`, `shift_activities`, `add_wbs`, `reschedule`, `undo_last`, `export_xer`.
