# Frail - Daemon-first AI Chat + Feishu Bot

## Tech Stack
- **Runtime**: Bun
- **TUI**: Ink + @inkjs/ui (attach mode)
- **AI**: @anthropic-ai/claude-agent-sdk (query API, session persistence)
- **Config**: cosmiconfig + YAML (`~/.config/frail/config.yaml`)
- **Persistence**: bun:sqlite (`~/.config/frail/threads.db`)
- **IPC**: Unix socket (`~/.config/frail/frail.sock`, JSON-line protocol)
- **Feishu**: @larksuiteoapi/node-sdk (WebSocket, text + image messages)

## CLI Commands
- `frail` — Auto-start daemon + attach TUI
- `frail start` — Start daemon in background
- `frail stop` — Stop daemon
- `frail status` — Show daemon status
- `frail attach` — Attach TUI to running daemon
- `frail logs` — Tail daemon log file
- `frail init` — Run setup wizard
- `bun test` — Run tests

## Architecture
```
frail daemon (background process)
├── AgentSession — single SDK session (persistSession + autoCompact)
├── IPC server — Unix socket, JSON-line protocol
├── Feishu WS client — text + image messages
├── Message persistence — SQLite
└── Logger — ~/.config/frail/frail.log

frail attach (TUI)
├── IPC client → daemon
├── MessageList, InputBar, StatusBar (Ink components)
└── [Feishu] source tags on messages
```

## Project Structure
```
src/
├── cli.tsx              # Entry point, subcommand routing
├── daemon/
│   ├── index.ts         # Daemon main loop
│   ├── session.ts       # AgentSession class (single SDK session)
│   ├── ipc-server.ts    # Unix socket server
│   ├── ipc-client.ts    # Unix socket client (for attach)
│   ├── process.ts       # PID file, start/stop daemon
│   └── logger.ts        # File-based logger
├── ai/agent.ts          # query() options builder (shared)
├── config/
│   ├── schema.ts        # Zod config schema
│   └── loader.ts        # cosmiconfig + env loading
├── db/threads.ts        # SQLite: threads, messages, daemon_state, session_messages
├── components/
│   ├── AttachView.tsx    # TUI for attached mode
│   ├── MessageList.tsx   # Message rendering (source tags)
│   ├── InputBar.tsx      # Text input with slash completions
│   ├── StatusBar.tsx     # Model, session, feishu status
│   └── ...              # SetupWizard, ConfigPanel, etc.
├── feishu/
│   ├── client.ts        # Lark WSClient, image download
│   └── handler.ts       # Message handler → session.chat()
└── commands/index.ts    # Slash command registry
```

## Config (`~/.config/frail/config.yaml`)
```yaml
provider:
  model: claude-sonnet-4-20250514
  apiKey: ""       # or ANTHROPIC_API_KEY env
  baseURL: ""      # or ANTHROPIC_BASE_URL env
feishu:
  enabled: false
  appId: ""        # or FEISHU_APP_ID env
  appSecret: ""    # or FEISHU_APP_SECRET env
  domain: feishu   # or lark
```
