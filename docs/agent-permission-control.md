# Agent 权限管控：调研、踩坑与选型

## 目标

限制 frail 内置 agent 只能访问 `workDir` 目录内的文件，防止读取用户电脑上其他目录的敏感数据。

## 调研：Claude Code 源码分析

通过阅读 Claude Code 源码（`~/Downloads/claude-code-main/src/`），梳理出工具执行的完整权限检查链：

```
model 发起 tool_use
  → inputSchema.safeParse()        # zod 类型校验
  → tool.validateInput()           # 工具自身校验（deny 规则、路径安全检查）
  → tool.checkPermissions()        # 权限检查（pathInAllowedWorkingPath）
  → canUseTool()                   # 外部权限回调
  → tool.call()                    # 实际执行
```

### 关键文件

| 文件 | 作用 |
|------|------|
| `src/services/tools/toolExecution.ts` | 工具执行主流程，调用 validateInput → checkPermissions → canUseTool → call |
| `src/tools/FileReadTool/FileReadTool.ts` | Read 工具，`validateInput` 中检查 deny 规则，`checkPermissions` 中检查工作目录 |
| `src/utils/permissions/filesystem.ts` | `pathInAllowedWorkingPath`、`matchingRuleForInput` 等核心权限函数 |
| `src/utils/permissions/pathValidation.ts` | `isPathAllowed`、`validatePath` — 完整路径校验逻辑 |
| `src/utils/sandbox/sandbox-adapter.ts` | Sandbox 适配层，桥接 `@anthropic-ai/sandbox-runtime` 和 Claude CLI 配置 |
| `src/Tool.ts` | Tool 基类定义，`checkPermissions` 默认返回 allow |

### Claude Code 的两层权限体系

1. **validateInput（始终执行）** — 检查 `toolPermissionContext` 中的 deny 规则。deny 规则来自 `.claude/settings.json`，不是 SDK `query()` 的 options。
2. **checkPermissions（可能被跳过）** — 检查 `pathInAllowedWorkingPath`（cwd + additionalDirectories）。行为取决于 `permissionMode`。

### Sandbox 机制

Sandbox 在 macOS 上使用 **seatbelt**（`sandbox-exec`），是**内核级进程隔离**，不是应用层路径检查。Sandbox 只限制 Bash 子进程的文件系统访问，不影响 Read/Glob/Grep（这些工具在主进程内执行）。

## 失败的尝试

### 尝试 1：`bypassPermissions` + `canUseTool`

```typescript
permissionMode: "bypassPermissions",
canUseTool: buildCanUseTool(workDir),
```

**结果：失败。** `bypassPermissions` 跳过整个权限检查链（包括 `checkPermissions` 和 `canUseTool`），工具直接执行。

**教训：** `bypassPermissions` 字面意思就是"绕过所有权限"，`canUseTool` 不会被调用。

### 尝试 2：`dontAsk` + `allowedTools` + `canUseTool`

```typescript
permissionMode: "dontAsk",
allowedTools: ["Bash", "Read", "Glob", "Grep"],
canUseTool: buildCanUseTool(workDir),
```

**结果：失败。** `dontAsk` 模式下，`allowedTools` 中的工具**直接放行**，不触发 `canUseTool`。`dontAsk` 只对不在 `allowedTools` 中的工具 deny。

**教训：** `allowedTools` 的作用是"预授权白名单"，白名单内的工具不经过任何权限回调。

### 尝试 3：`dontAsk` + `cwd`（依赖 SDK 内部路径限制）

```typescript
permissionMode: "dontAsk",
cwd: workDir,
allowedTools: ["Bash", "Read", "Glob", "Grep"],
```

**结果：失败。** `cwd` 只设置工具的默认工作目录（相对路径的解析基准），不限制绝对路径访问。SDK 的 `pathInAllowedWorkingPath` 检查在 `checkPermissions` 中，而 `allowedTools` 的工具跳过了 `checkPermissions`。

**教训：** `cwd` 不是 sandbox，它不阻止 `Read(/absolute/path/outside/cwd)`。

### 尝试 4：`sandbox.filesystem.denyRead`

```typescript
sandbox: {
  enabled: true,
  filesystem: {
    denyRead: ["/**"],
    denyWrite: ["/**"],
  },
},
```

**结果：对 Bash 有效，对 Read/Glob/Grep 无效。** Sandbox（seatbelt）只限制 Bash 子进程，Read/Glob/Grep 在主进程内执行，不受 sandbox 影响。

**教训：** Sandbox 是进程级隔离，只影响通过 `sandbox-exec` 启动的子进程（Bash）。

## 最终方案

### 方案 B：`permissionMode: "default"` + `allowedTools: []` + `canUseTool`

```typescript
permissionMode: "default",
tools: ["Bash", "Read", "Glob", "Grep"],
allowedTools: [],  // 关键：不预授权任何工具
canUseTool: buildCanUseTool(workDir),
sandbox: {
  enabled: true,
  autoAllowBashIfSandboxed: true,
  filesystem: { denyWrite: ["/**"] },
},
```

**核心思路：**

1. `allowedTools: []` — 不预授权任何工具，所有工具调用都会触发权限检查
2. `permissionMode: "default"` — 未授权工具调用 `canUseTool` 回调
3. `canUseTool` — 检查 `file_path`/`path` 参数是否在 workDir 内
4. `sandbox` — 额外限制 Bash 子进程（内核级，防止 Bash 绕过）

**`canUseTool` 实现：**

```typescript
function buildCanUseTool(workDir: string) {
  const resolved = path.resolve(workDir);
  return async (toolName, input, _options) => {
    const filePath = (input.file_path ?? input.path ?? "") as string;
    if (filePath) {
      const abs = path.isAbsolute(filePath) ? filePath : path.resolve(resolved, filePath);
      const resolvedPath = path.resolve(abs);
      if (!resolvedPath.startsWith(resolved + "/") && resolvedPath !== resolved) {
        return { behavior: "deny", message: `Access denied: outside workDir` };
      }
    }
    return { behavior: "allow" };
  };
}
```

### 选型理由

| 方案 | Read/Glob/Grep 限制 | Bash 限制 | 可行性 |
|------|---------------------|-----------|--------|
| bypassPermissions + canUseTool | canUseTool 被跳过 | sandbox 有效 | 不可行 |
| dontAsk + allowedTools | allowedTools 直接放行 | sandbox 有效 | 不可行 |
| dontAsk + cwd | cwd 不限制绝对路径 | sandbox 有效 | 不可行 |
| **default + allowedTools:[] + canUseTool** | **canUseTool 拦截** | **sandbox 有效** | **可行** |

## 相关文件

- `src/daemon/session.ts` — `buildCommonOptions` + `buildCanUseTool`
- `src/ai/agent.ts` — `buildQueryOptions`（TUI 直连模式）

## 注意事项

1. `canUseTool` 只检查 `file_path` 和 `path` 参数。Bash 的 `command` 参数（如 `cat /etc/passwd`）由 sandbox（seatbelt）在内核级限制。
2. 相对路径会被解析为相对于 workDir 的绝对路径再检查。
3. 如果 SDK 未来版本改变了 `permissionMode` 和 `canUseTool` 的交互逻辑，需要重新验证。
