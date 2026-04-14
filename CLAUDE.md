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
- `frail` — Show help
- `frail attach` — Connect to daemon TUI
- `frail daemon` — Run daemon in foreground (for dev)
- `frail status` — Live daemon status (Ctrl+C to exit)
- `frail stop` — Stop daemon
- `frail logs` — Tail daemon logs
- `frail config` — View/set config (`config <key> [value]`)
- `frail init` — Setup wizard (LLM / Linear / Feishu)
- `frail uninstall` — Remove LaunchAgent
- `bun run dev` — Daemon with hot reload
- `bun test` — Run tests

## Git Conventions
- Use [Conventional Commits](https://www.conventionalcommits.org/)
- Format: `<type>: <description>`
- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
- Examples:
  - `feat: add image support for feishu post messages`
  - `fix: resolve daemon restart on launchd stop`
  - `docs: document bun + lark sdk stream issue`

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
├── cli.tsx                # Entry point, subcommand routing
├── daemon/
│   ├── index.ts           # Daemon main loop
│   ├── session.ts         # AgentSession class (single SDK session)
│   ├── ipc-server.ts      # Unix socket server
│   ├── ipc-client.ts      # Unix socket client (for attach)
│   ├── process.ts         # PID file, start/stop daemon
│   ├── launchd.ts         # macOS LaunchAgent management
│   └── logger.ts          # File-based logger
├── config/
│   ├── schema.ts          # Zod config schema
│   └── loader.ts          # cosmiconfig + env loading
├── db/threads.ts          # SQLite: threads, messages, daemon_state, session_messages
├── hooks/
│   └── useConfig.ts       # React hook for config access
├── components/
│   ├── AttachView.tsx      # TUI for attached mode
│   ├── MessageList.tsx     # Message rendering (source tags)
│   ├── InputBar.tsx        # Text input with slash completions
│   ├── StatusBar.tsx       # Model, session, feishu status
│   ├── ThreadList.tsx      # Thread listing and selection
│   ├── ConfigPanel.tsx     # Config viewing/editing UI
│   └── SetupWizard.tsx     # Interactive setup wizard
├── feishu/
│   ├── client.ts           # Lark WSClient, image download
│   └── handler.ts          # Message handler → session.chat()
└── commands/index.ts       # Slash command registry
```

## Config (`~/.config/frail/config.yaml`)
```yaml
systemPrompt: ""           # Custom system instructions
workDir: "."               # Project root for agent file access

provider:
  model: claude-sonnet-4-20250514
  apiKey: ""               # or ANTHROPIC_API_KEY env
  baseURL: ""              # or ANTHROPIC_BASE_URL env

feishu:
  enabled: false
  appId: ""                # or FEISHU_APP_ID env
  appSecret: ""            # or FEISHU_APP_SECRET env
  domain: feishu           # or lark

conversation:
  maxMessages: 50          # Max messages kept in history
  ttlMinutes: 30           # Message time-to-live

agent:
  timeoutMinutes: 5        # Agent response timeout
```

Linear integration uses `linear` CLI (https://github.com/schpet/linear-cli). Run `linear auth` to authenticate.
