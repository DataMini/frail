# Frail - Daemon-first AI Chat + Feishu Bot

## Tech Stack
- **Runtime**: Bun
- **Agent**: `@mariozechner/pi-coding-agent` SDK (`createAgentSession`) on top of `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`
- **TUI**: `@mariozechner/pi-tui` primitives (no Ink/React)
- **IPC**: Unix socket (`~/.config/frail/frail.sock`) speaking pi's `RpcCommand`/`RpcResponse` JSON-line protocol
- **Session persistence**: pi's `SessionManager` (JSONL files under `~/.pi/agent/sessions/`)
- **Auth & settings**: pi's `AuthStorage` + `SettingsManager` under `~/.pi/agent/`
- **Linear**: `@linear/sdk` exposed via 7 native tools (no `linear` CLI)
- **Feishu**: `@larksuiteoapi/node-sdk` (WebSocket, text + image)
- **Config (frail-only)**: cosmiconfig + YAML at `~/.config/frail/config.yaml`

## CLI Commands
- `frail` — Show help
- `frail attach` — pi-tui client connected to the daemon
- `frail daemon` — Run daemon in foreground (for dev)
- `frail status` — Daemon status snapshot (one-shot)
- `frail stop` — Stop daemon
- `frail logs` — Tail daemon logs
- `frail config [key] [value]` — View/set frail-only keys (workDir, systemPrompt, feishu.*, linear.apiKey)
- `frail init` — Set workDir / Feishu / Linear; LLM auth handled in-TUI via `/login`
- `frail uninstall` — Remove macOS LaunchAgent
- `bun run dev` — Daemon with hot reload

LLM credentials are managed by pi (`/login` slash command inside `frail attach`, or env vars like `ANTHROPIC_API_KEY`).

## Git Conventions
- Use [Conventional Commits](https://www.conventionalcommits.org/)
- Format: `<type>: <description>`
- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

## Architecture
```
frail daemon (background process)
├── pi AgentSession (createAgentSession)
│   ├── pi-agent-core Agent (loop, tools, abort, streaming)
│   ├── pi SessionManager (JSONL session files)
│   ├── pi SettingsManager + AuthStorage
│   ├── pi ModelRegistry
│   └── tools: read, grep, find, ls (built-in)  +  linear_* (frail-native)
├── Unix-socket RPC bridge (~/.config/frail/frail.sock)
│   • wire format = pi's RpcCommand / RpcResponse + AgentSessionEvents
│   • plus frail extension events: frail_status, frail_source
├── Feishu adapter — Lark WS → frail.prompt(text, "feishu") → reply
├── PID file + macOS LaunchAgent
└── File logger — ~/.config/frail/frail.log

frail attach (TUI)
├── Custom Unix-socket RPC client → daemon
├── pi-tui runtime (TUI / Editor / Text / Container)
└── [Feishu] source tags on messages (frail_source events)
```

## Project Structure
```
src/
├── cli.ts                  # Entry point, subcommand routing
├── daemon/
│   ├── index.ts            # Daemon main loop
│   ├── session.ts          # bootSession() — pi AgentSession factory
│   ├── rpc-bridge.ts       # Unix-socket RPC bridge (replaces ipc-server)
│   ├── process.ts          # PID file, start/stop, launchd glue
│   ├── launchd.ts          # macOS LaunchAgent management
│   └── logger.ts           # File-based logger
├── config/
│   ├── schema.ts           # Slim Zod schema (frail-only keys)
│   └── loader.ts           # cosmiconfig + YAML
├── tools/
│   └── linear.ts           # Seven native Linear tools (@linear/sdk)
├── tui/
│   └── attach.ts           # pi-tui based attach client
└── feishu/
    ├── client.ts           # Lark WSClient + image download
    └── handler.ts          # Inbound Lark message → frail.prompt()
```

## Config (`~/.config/frail/config.yaml`)
Only frail-specific keys live here. LLM credentials and model preferences live in pi's stores under `~/.pi/agent/`.

```yaml
systemPrompt: ""        # Optional override of the Frail persona prompt
workDir: "."            # Project root for agent file access

# Optional. Defaults to [workDir]. Path sandbox for read/grep/find/ls;
# any tool call outside these roots is blocked before execution.
# Files inside workDir that are git-ignored (per `git check-ignore`) are also
# blocked — keeps .env, secrets, build outputs, node_modules out of reach.
allowedRoots:
  - "."

# Idle minutes before the daemon auto-rolls onto a fresh session (same as /new).
# Set to 0 to disable. Context-overflow compaction is handled by pi automatically
# and is independent of this knob.
autoNewSessionIdleMinutes: 30

feishu:
  enabled: false
  appId: ""             # or FEISHU_APP_ID env
  appSecret: ""         # or FEISHU_APP_SECRET env
  domain: feishu        # or lark

linear:
  apiKey: ""            # Linear personal API key (lin_api_...)
```

## Linear tools (read + non-destructive writes)
The agent receives 7 native tools — no shell access:
- `linear_list_my_issues({ state?, teamId? })`
- `linear_search_issues({ query, teamId?, teamKey?, state?, label? })`
- `linear_view_issue({ id, includeComments? })`
- `linear_create_issue({ title, description?, teamId | teamKey, priority?, labels?, projectId?, assigneeSelf? })`
- `linear_update_issue({ id, title?, description?, state?, priority?, assigneeSelf?, assigneeId?, addLabels?, removeLabels?, projectId? })`
- `linear_create_comment({ issueId, body })`
- `linear_list_comments({ issueId, limit? })`

Issue deletion is intentionally out of the tool surface — the agent returns the issue URL for the user to finish in the Linear UI.

## RPC bridge protocol
Reuses pi's `RpcCommand` / `RpcResponse` types from `@mariozechner/pi-coding-agent`, framed as JSON lines over `~/.config/frail/frail.sock`. Pi `AgentSessionEvent`s are broadcast to every attached client. Two frail-specific event types are added:

- `{ type: "frail_status", startedAt, feishu: { enabled, connected }, linear: { configured } }` — sent on connect and on demand.
- `{ type: "frail_source", source: "tui" | "feishu", text }` — emitted right before a user prompt enters the session, so the TUI can tag `[Feishu]` on inbound messages.

Multi-session navigation commands (`new_session`, `fork`, `clone`, `switch_session`) are not supported — frail keeps a single shared session.
