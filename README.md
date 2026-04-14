# Frail

基于 [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) 的常驻 AI 助手，连接飞书群聊和 Linear 项目管理。

- **Daemon 架构** — 后台常驻进程，TUI 随时 attach/detach，macOS LaunchAgent 开机自启
- **飞书集成** — WebSocket 实时接收群聊消息（文本、图片、富文本），自动回复
- **Linear 集成** — 通过 [linear-cli](https://github.com/schpet/linear-cli) 连接 Linear，搜索、创建和管理 issue
- **代码工具** — 内置文件读取、搜索、沙箱 Bash，让 AI 理解你的代码库

## 安装

```bash
git clone https://github.com/DataMini/frail.git
cd frail
bun install
bun link
```

需要 [Bun](https://bun.sh) >= 1.x 和 macOS。

## 使用

```bash
frail init      # 配置向导（API Key / 飞书）
frail daemon    # 前台启动（开发用）
frail attach    # 连接 TUI
frail status    # 查看状态
frail stop      # 停止
frail logs      # 查看日志
```

## 配置

运行 `frail init` 完成初始配置，或直接编辑 `~/.config/frail/config.yaml`。

## 开发

```bash
bun run dev    # 热重载
bun test       # 测试
```

## License

[MIT](LICENSE)
