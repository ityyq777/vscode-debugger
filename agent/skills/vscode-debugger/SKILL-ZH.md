---
name: vscode-debugger
description: 通过 HTTP API 控制 VSCode 调试器。用于调试代码、检查变量、单步执行函数或分析运行时行为。此技能通过本地 HTTP 代理启用同步阻塞调试操作。
user-invocable: true
---
# VSCode 调试器代理

一个同步阻塞代理，用于控制 VSCode 调试器。此工具允许通过发送 HTTP 请求来调试代码，并等待调试器状态变化。

## 核心概念

### 端口发现
**重要**: 代理端口是自动分配的。连接前，必须读取端口文件：

```
.read file: .vscode/debug-proxy.port
```

使用此文件中的端口号作为基础 URL（例如 `http://localhost:xxxx`）

### 自我触发断点（死锁风险）
如果只能运行一个终端/代理，请勿向被调试服务发送 HTTP 请求（例如 `curl http://127.0.0.1:5000/users/1`）。这会导致**死锁**，因为你在阻塞终端的同时等待同一终端的响应。使用 `/wait`，让用户或外部进程触发断点。只有多终端代理才能安全地自行触发断点。

### 同步阻塞
当你发送 `next`、`continue` 或 `wait` 等命令时，HTTP 请求会**阻塞**，直到调试器暂停（例如命中断点、完成单步或超时）。如果请求花费较长时间，不要认为它失败了——这是正常的。

### frameId 作为凭证
`/wait` 返回的 `frameId` 是凭证。所有后续请求（`/variables`、`/evaluate`、`/control`）都应包含此 `frameId`。如果调试器状态发生变化（例如用户手动继续），代理将返回错误。

### 两种调试器状态
- `running`: 调试器正在执行代码
- `stopped`: 调试器已暂停（在断点、单步后等）

---

## 端点

### 1. 健康检查
- **端点**: `GET /health`
- **阻塞**: 否
- **返回**: `{ "status": "ok", "service": "vscode-debugger-proxy" }`

### 2. 获取调试状态
- **端点**: `GET /status`
- **阻塞**: 否
- **返回**:
```json
{
  "success": true,
  "active": true,
  "status": "running" | "stopped" | "terminated",
  "reason": "breakpoint" | "step" | "exception" | "entry",
  "file": "/path/to/file.py",
  "line": 10,
  "frameId": 4
}
```

### 3. 设置断点
- **端点**: `POST /breakpoints`
- **阻塞**: 否
- **请求体**（Map 格式 - 支持多文件批量设置）:
```json
{
  "/absolute/path/to/app.py": [29, 30],
  "/absolute/path/to/utils.py": [10, 15]
}
```
- **返回**:
```json
{
  "success": true,
  "breakpoints": {
    "/absolute/path/to/app.py": [29, 30],
    "/absolute/path/to/utils.py": [10, 15]
  },
  "message": "Breakpoints set: /absolute/path/to/app.py:29,30 /absolute/path/to/utils.py:10,15"
}
```

### 4. 获取断点列表
- **端点**: `GET /breakpoints`
- **描述**: 获取所有当前设置的断点
- **阻塞**: 否
- **返回**:
```json
{
  "success": true,
  "breakpoints": {
    "/absolute/path/to/app.py": [
      { "line": 29, "enabled": true },
      { "line": 35, "enabled": true }
    ]
  }
}
```

### 5. 启动调试
- **端点**: `POST /launch`
- **描述**: 使用 launch.json 中的配置名称启动调试会话
- **阻塞**: **是** - 等待调试器在入口或第一个断点处停止
- **请求体**:
```json
{
  "config": "Python: Flask"
}
```
- **注意**: `config` 值必须与 launch.json 中定义配置名称匹配
- **返回**:
```json
{
  "success": true,
  "status": "stopped",
  "reason": "entry" | "breakpoint",
  "file": "/path/to/file.py",
  "line": 10,
  "frameId": 4,
  "message": "Stopped at /path/to/file.py:10 (entry)"
}
```

### 6. 重新启动调试
- **端点**: `POST /relaunch`
- **描述**: 停止当前会话并启动新会话（相当于 stop + launch）
- **阻塞**: **是** - 与 `/launch` 相同
- **请求体**:
```json
{
  "config": "Python: Flask"
}
```

### 7. 等待断点
- **端点**: `POST /wait`
- **描述**: 阻塞直到调试器停止（命中断点、单步完成等）
- **阻塞**: **是** - 等待调试器暂停或超时
- **查询参数**: `timeout`（毫秒，默认 30000，-1 表示永久等待）
- **返回**:
```json
{
  "success": true,
  "status": "stopped",
  "reason": "breakpoint" | "step" | "exception" | "entry",
  "file": "/path/to/file.py",
  "line": 29,
  "frameId": 4,
  "message": "Stopped at /path/to/file.py:29 (breakpoint)"
}
```

### 8. 调试控制（单步/继续）
- **端点**: `POST /control`
- **描述**: 控制调试器执行
- **阻塞**: 取决于 action 和 `wait` 参数
- **请求体**:
```json
{
  "action": "next" | "continue" | "stepIn" | "stepOut",
  "wait": true,
  "timeout": -1
}
```
- **动作**:
  - `next`: 单步跳过（执行当前行，停在下一行）
  - `continue`: 继续执行直到下一个断点
  - `stepIn`: 单步进入函数调用
  - `stepOut`: 单步退出当前函数
- **参数**:
  - `wait`: 仅对 `continue` 有效。如果为 `true`，阻塞直到下一个断点。如果为 `false`，立即返回。
  - `timeout`: 仅对 `continue` 且 `wait=true` 时有效。使用 `-1` 表示永久等待。
- **返回**:
```json
{
  "success": true,
  "status": "stopped",
  "reason": "breakpoint" | "step",
  "file": "/path/to/file.py",
  "line": 35,
  "frameId": 7,
  "message": "Action 'continue' completed, paused at /path/to/file.py:35 (breakpoint)"
}
```

### 9. 查看变量
- **端点**: `POST /variables`
- **描述**: 获取当前作用域的变量
- **阻塞**: 否
- **请求体**:
```json
{
  "frameId": 4,
  "scope": {
    "Locals": ["user_id", "user"],
    "Globals": ["*"]
  }
}
```
- **字段说明**:
  - `frameId`: `/wait` 响应中的 frameId（作为凭证）
  - `scope`: 可选，作用域名称到变量列表的映射。使用 `["*"]` 获取该作用域所有变量。如果省略，返回所有作用域的所有变量。
- **frameId 校验**: 如果调试器已移动到不同帧，返回错误：
```json
{
  "success": false,
  "error": "Frame has changed. The debugger is no longer at the requested frame.",
  "currentFrame": {
    "frameId": 15,
    "file": "/path/to/file.py",
    "line": 40
  }
}
```
- **返回**:
```json
{
  "success": true,
  "variables": {
    "Locals": {
      "user_id": "1",
      "name": "Alice"
    },
    "Globals": {
      "app_name": "MyApp"
    }
  },
  "frameId": 4
}
```
- **注意**: 如果不提供 `scope`，返回 Locals 和 Globals 下所有变量。
- **警告**: 不建议省略 `scope`！在大型应用程序中，返回 Locals 和 Globals 的所有变量会造成巨大的网络传输开销，减慢调试速度。尽可能指定你需要的精确变量。

### 10. 执行表达式
- **端点**: `POST /evaluate`
- **描述**: 在调试控制台 REPL 中执行表达式
- **阻塞**: 否
- **请求体**:
```json
{
  "expression": "user_id + 10",
  "frameId": 4,
  "context": "repl"
}
```
- **字段**:
  - `expression`: 必填。要执行的表达式
  - `frameId`: 可选，默认为当前帧。来自 `/wait` 响应的帧 ID
  - `context`: 可选，默认为 `repl`。可为：`repl`、`watch`、`hover`、`variables`
- **返回**:
```json
{
  "success": true,
  "result": "11",
  "type": "int",
  "variablesReference": 0,
  "namedVariables": 0,
  "indexedVariables": 0
}
```
- **说明**: 如果表达式返回复杂对象（字典、列表、对象等），`variablesReference > 0` 表示包含子变量，可通过 `/variables` 获取。

**`context` 参数取值说明**:
- `repl` (默认): 调试控制台 REPL。用于计算表达式和执行运算。
- `watch`: 监视表达式面板。用于添加或更新监视表达式。
- `hover`: 悬停提示框。用于悬停在代码上时显示信息。
- `variables`: 变量面板。用于调试窗格的变量区域。

**建议**: 大多数情况下使用 `repl` 上下文。其他上下文专用于各自对应的 VSCode UI 面板。

### 11. 获取栈追踪
- **端点**: `GET /stacktrace`
- **描述**: 获取当前调用栈帧信息
- **阻塞**: 否
- **返回**:
```json
{
  "success": true,
  "frame": {
    "id": 4,
    "name": "get_user",
    "file": "/path/to/file.py",
    "line": 29,
    "column": 1
  }
}
```

### 12. 停止调试
- **端点**: `POST /stop`
- **阻塞**: 否
- **返回**:
```json
{
  "success": true,
  "message": "Debug session stopped"
}
```

---

## 工作流程示例

### 标准调试工作流程

```bash
# 1. 设置断点（可在启动前或启动后设置）
curl -X POST http://localhost:4711/breakpoints \
  -H "Content-Type: application/json" \
  -d '{"d:/project/app.py": [29]}'

# 2. 启动调试（阻塞直到调试器停止）
curl -X POST http://localhost:4711/launch \
  -H "Content-Type: application/json" \
  -d '{"config": "Python: Flask"}'

# 响应: { "status": "stopped", "reason": "entry", "frameId": 3, ... }

# 3. 等待断点（阻塞直到命中断点）
curl -X POST http://localhost:4711/wait -H "Content-Type: application/json"

# 4. 获取变量（使用 wait 响应中的 frameId）
curl -X POST http://localhost:4711/variables \
  -H "Content-Type: application/json" \
  -d '{"frameId": 4, "scope": {"Locals": ["*"], "Globals": ["*"]}}'

# 5. 执行表达式（例如检查计算结果）
curl -X POST http://localhost:4711/evaluate \
  -H "Content-Type: application/json" \
  -d '{"expression": "user_id + 10", "frameId": 4}'

# 6. 单步执行代码
curl -X POST http://localhost:4711/control \
  -H "Content-Type: application/json" \
  -d '{"action": "next"}'

# 7. 继续到下一个断点（阻塞）
curl -X POST http://localhost:4711/control \
  -H "Content-Type: application/json" \
  -d '{"action": "continue", "wait": true, "timeout": -1}'
```

### 调试逻辑错误

**目标**: 调试为什么变量 `i` 在循环中永不重置

```bash
# 步骤 1: 在可疑行设置断点
curl -X POST http://localhost:4711/breakpoints \
  -H "Content-Type: application/json" \
  -d '{"d:/project/loop.py": [10]}'

# 步骤 2: 启动调试（在入口阻塞）
curl -X POST http://localhost:4711/launch \
  -H "Content-Type: application/json" \
  -d '{"config": "Python: Current File"}'

# 步骤 3: 等待断点
curl -X POST http://localhost:4711/wait -H "Content-Type: application/json"
# 响应: { "frameId": 4, "line": 10, ... }

# 步骤 4: 检查变量值
curl -X POST http://localhost:4711/variables \
  -H "Content-Type: application/json" \
  -d '{"frameId": 4, "scope": {"Locals": ["i", "max"]}}'
# 响应: { "variables": { "Locals": { "i": 100, "max": 10 } } }

# 步骤 5: 执行表达式以理解行为
curl -X POST http://localhost:4711/evaluate \
  -H "Content-Type: application/json" \
  -d '{"expression": "i - max", "frameId": 4}'
# 响应: { "result": "90", "type": "int" }

# 步骤 6: 单步执行观察行为
curl -X POST http://localhost:4711/control \
  -H "Content-Type: application/json" \
  -d '{"action": "next"}'
# 响应: { "line": 11, "frameId": 5, ... }
# i 现在是 101 - 递增而没有重置

# 步骤 7: 分析并建议修复
```

---

## 错误处理

### 超时
如果阻塞操作超时：
```json
{
  "success": true,
  "status": "timeout",
  "reason": "timeout",
  "message": "Debug operation timed out"
}
```
**操作**:
1. 发送 `POST /control { "action": "continue", "wait": true }` 继续到下一个断点
2. 发送 `POST /stop` 终止调试会话

### Frame 已改变错误
如果用户手动继续或单步，你的 frameId 将变得无效：
```json
{
  "success": false,
  "error": "Frame has changed. The debugger is no longer at the requested frame.",
  "currentFrame": { "frameId": 15, "file": "...", "line": 40 }
}
```
**操作**: 再次调用 `/wait` 获取新的调试器状态。

### 无活动调试会话
```json
{
  "success": false,
  "error": "Debugger is not active. Start debugging first with /launch."
}
```

---

## 重要提示

1. **行号从 1 开始**: API 使用从 1 开始的人类可读行号。

2. **使用绝对路径**: 请求中的文件路径应该是绝对路径。

3. **frameId 是你的检查点**: 始终在后续请求中包含 `/wait` 返回的 `frameId`。这确保你仍在同一调试位置。

4. **阻塞是正常的**: 如果请求花费比预期更长的时间，不要重试或显示错误消息。调试器只是在等待。

5. **支持多文件**: 断点格式支持使用 Map 格式一次性在多个文件设置断点。

6. **保持调试器运行**: 找到有用信息后不要停止调试器（`/stop`）。启动大型系统可能非常耗时（几秒到几分钟）。保持调试器运行并根据需要继续调试。只有在完全结束调试或需要重启应用程序时才停止。
