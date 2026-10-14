# Schedule Composer

Chat with Claude about a Primavera P6 schedule and watch it change. Open an XER (or start a blank project), ask for edits in plain English ("add a 10-day punch list after Final Clean", "shift MEP rough-in two weeks", "what's driving substantial completion?"), see the table and Gantt move as each tool call lands, then export the XER back to P6.

**Try it:** https://realworldbuilder.github.io/schedule-composer/ (runs entirely in your browser; paste an Anthropic API key under "API key". The key stays in your browser's localStorage and goes only to api.anthropic.com.)

Engine: lossless XER round trip, P6 calendars, a CPM scheduler (FS/SS/FF/SF, lags, constraints, retained logic), undo history. Agent: 17 tools (search, trace driving path, logic check, add/update/delete activities and relationships, shift, WBS, undo, export).

See `CLAUDE.md` for layout, run commands and engine notes, and `PROTOCOL.md` for the UI/backend protocol.
