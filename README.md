# Frail

基于 [pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) 的常驻 AI 助手，连接飞书群聊和 Linear 项目管理。

- **Daemon 架构** — 后台常驻进程，TUI 随时 attach/detach，macOS LaunchAgent 开机自启
- **飞书集成** — WebSocket 实时接收文本 / 图片 / 富文本，图片以 `ImageContent` 直接喂给模型，无需落盘
- **Linear 集成** — 通过 `@linear/sdk` 暴露 7 个原生工具（搜索 / 查看 / 创建 / 更新 / 评论 issue）
- **只读代码工具** — `read` / `grep` / `find` / `ls`，路径沙箱限制在 `workDir`，gitignore 命中的文件（`.env`、构建产物等）一并屏蔽
- **会话治理** — 空闲 30 分钟自动 `/new` 开新会话；上下文超长时由 pi 自动 compact
- **多模型** — 通过 pi 的 `/login` 在 TUI 内登录 Anthropic / OpenAI / 等任意 provider

## 安装

```bash
git clone https://github.com/DataMini/frail.git
cd frail
bun install
bun link
```

需要 [Bun](https://bun.sh) >= 1.x 和 macOS（LaunchAgent 仅在 macOS 生效，daemon 本身可在任何 Unix）。

## 使用

```bash
frail init      # 设置 workDir / 飞书 / Linear，LLM 凭据在 TUI 里 /login
frail daemon    # 前台启动 daemon（开发用）
frail attach    # 连接 TUI
frail status    # 状态快照
frail stop      # 停止 daemon
frail logs      # 跟随日志
frail uninstall # 移除 LaunchAgent
```

TUI 内可用斜杠命令：

- `/login` / `/logout` — 管理 LLM 凭据
- `/new` — 立即开新会话（清空上下文）
- `/compact` — 立即压缩当前会话
- `/model` 等 pi 内置命令照常可用

## 配置

`frail init` 之后，可直接编辑 `~/.config/frail/config.yaml`：

```yaml
systemPrompt: ""              # 可选：覆盖默认 Frail 人格
workDir: "."                  # 项目根目录，agent 文件工具的根路径

# 可选。默认 [workDir]。read/grep/find/ls 的路径沙箱白名单，
# 命中 .gitignore 的文件（.env、node_modules、构建产物等）一并屏蔽。
allowedRoots:
  - "."

# 空闲多少分钟后自动 /new 开新会话。0 关闭。
# 上下文超长由 pi 自己 compact，跟这个无关。
autoNewSessionIdleMinutes: 30

feishu:
  enabled: false
  appId: ""                   # 也可用 FEISHU_APP_ID 环境变量
  appSecret: ""               # 也可用 FEISHU_APP_SECRET 环境变量
  domain: feishu              # 或 lark

linear:
  apiKey: ""                  # Linear 个人 API key（lin_api_...）
```

LLM 凭据和模型偏好不在这里 —— 它们由 pi 管理在 `~/.pi/agent/`（`auth.json` / `settings.json`），通过 `/login` 写入。

## 架构

```
frail daemon (常驻进程)
├── pi AgentSession             — agent loop / 工具 / 流式 / 持久化
│   ├── pi SessionManager       — JSONL session 文件
│   ├── pi AuthStorage          — LLM 凭据
│   └── pi ModelRegistry        — 模型选择
├── 工具集
│   ├── read / grep / find / ls — pi 内置只读工具，受路径沙箱 + .gitignore 双重保护
│   └── linear_*                — frail 自带的 7 个 Linear 工具（@linear/sdk）
├── Unix-socket RPC bridge      — ~/.config/frail/frail.sock
│                                  pi 的 RpcCommand/RpcResponse 协议 + frail 扩展事件
├── 飞书 adapter                — Lark WS → frail.prompt(text, "feishu", images?)
│                                  图片直接以 ImageContent 喂入 pi，避免落盘
├── PID + macOS LaunchAgent
└── 文件日志                    — ~/.config/frail/frail.log

frail attach (TUI)
├── 自定义 Unix-socket RPC client
└── pi-tui 渲染 / 编辑器 / 自动补全
```

## Linear 工具

Agent 看到的 7 个工具（无 shell 访问）：

- `linear_list_my_issues({ state?, teamId? })`
- `linear_search_issues({ query, teamId?, teamKey?, state?, label? })`
- `linear_view_issue({ id, includeComments? })` — id 可以是 uuid 或 `ENG-123`
- `linear_create_issue({ title, description?, teamId | teamKey, priority?, labels?, projectId?, assigneeSelf? })`
- `linear_update_issue({ id, title?, description?, state?, priority?, assigneeSelf?, assigneeId?, addLabels?, removeLabels?, projectId? })`
- `linear_create_comment({ issueId, body })`
- `linear_list_comments({ issueId, limit? })`

Issue 删除有意不暴露 —— agent 会返回 URL 让用户在 Linear UI 里手动完成。

## 开发

```bash
bun run dev          # daemon 热重载
bun test             # 测试
bun x tsc --noEmit   # 类型检查
```

## License

[MIT](LICENSE)
