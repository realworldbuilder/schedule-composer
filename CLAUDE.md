# Schedule Composer

Cursor / Claude Code style editor for Primavera P6 **XER** schedules. A chat pane drives a Claude agent that edits the open schedule through tools; the activity table + Gantt in the browser update live over WebSocket as each tool call lands. Export the XER and import it into P6.

Started 13 Oct 2026. Runs on the Mac mini, port **4400**, bound to 0.0.0.0 (phone: `http://100.76.214.19:4400`).

## Layout

```
server.ts              HTTP + WebSocket + agent wiring. Opens samples/generated-200.xer at start (SC_OPEN=... to change).
lib/xer/               lossless XER parse/serialize (Windows-1252, ragged rows, byte-exact round trip)
lib/schedule/          dates, calendar (clndr_data), model (typed views + mutations), cpm (forward/backward pass), analyze, diff (wire shapes), blank (new empty project from the template XER)
lib/state.ts           Document: xer + schedule + cpm + undo history; mutate() reschedules and emits a `patch`
lib/agent/             prompt.ts (system prompt), tools.ts (zod schemas + handlers + in-process MCP server "sched"), session.ts (Agent SDK query per turn, resume by session id)
src/                   Preact UI (Vite). TopBar, Schedule (table + Gantt), Chat.
samples/               MPXJ samples + generated-200.xer (tools/sample.mjs). data/ (gitignored): uploads/, exports/, agent/ sessions, server.log
tools/sample.mjs       generates the sample (--tasks 5000 for a scale file); tools/chat.mjs sends one chat turn from the terminal
test/                  vitest: xer round trip, calendar, model, cpm hand cases, tool handlers
PROTOCOL.md            server <-> browser protocol (authoritative)
```

## Run

```bash
cd ~/projects/schedule-composer && pnpm test                 # 32 tests
node server.ts                                               # API + WS on 4400, serves dist/ when built
pnpm dev                                                     # Vite on 5174 with proxy (UI development)
pnpm build                                                   # tsc + vite build -> dist/
node tools/chat.mjs "what's driving substantial completion?"  # agent smoke test (SC_URL=ws://host:port/ws)
```

launchd: `cp com.william.schedule-composer.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.william.schedule-composer.plist`; restart with `launchctl kickstart -k gui/$(id -u)/com.william.schedule-composer`. Log `~/Library/Logs/schedule-composer.log`.

## New project

`POST /api/new { name, code?, start, hoursPerDay?, workDays? }` builds an empty project (root WBS, standard calendar) from `samples/PredecessorCalendar.xer`, saves it under `data/uploads/<code>.xer` and opens it. The agent then builds the schedule from chat: `add_wbs` per phase, `add_activities` (bulk, `chain: true`, up to 60 per call), `add_relationships`, `check_logic`. Tested: "build a first-draft kitchen remodel schedule" produced 24 activities with closed logic in ~70 s.

## Agent auth

The Agent SDK runs the `claude` CLI, which uses William's **Claude Max login** (`~/.claude/.credentials.json`). The server strips `ANTHROPIC_API_KEY` from the subprocess env so the key never wins. Personal use only (Anthropic does not allow offering a Max login to other users). To bill an API key instead: `SC_USE_API_KEY=1` with `ANTHROPIC_API_KEY` set. `SC_MODEL=opus|sonnet|<id>` overrides the model (default: the CLI default, currently Fable 5.1). `cost_usd` in turn_end is the SDK's API-equivalent figure, not a charge on Max.

## P6 facts baked into the engine

- Durations, lags, floats are hours. Dates `YYYY-MM-DD HH:MM`. Calendar `clndr_data` nested string: DaysOfWeek 1=Sun..7=Sat with `s|HH:MM|f|HH:MM` shifts; Exceptions `d|<Excel serial>`.
- P6 drops trailing empty values, so rows are ragged; the serializer never pads. Zero-row tables keep `%T`/`%F`.
- CPM v1: FS/SS/FF/SF with lag on the predecessor's calendar (SCHEDOPTIONS honoured for successor/24h/project), retained logic for active tasks, completes frozen, MSOA/MEOA/MSOB/MEOB/MSO/MEO/MAND constraints, FT_FF float type default. Skipped in v1: LOE and WBS-summary activities, ALAP, cross-project links, resource levelling.
- `applyCpm` writes early/late/planned dates, floats, `driving_path_flag`, `scd_end_date`. P6 recomputes all of that on F9 after import anyway.
- P6 re-import checklist: import as a new project (do not update an existing one the first time), then Schedule (F9) at the same data date and compare.

## Next ideas

Approve-each-change toggle (canUseTool), multiple open files, OpenAI provider, LOE/ALAP, resource assignments, baseline compare view, GitHub repo.
