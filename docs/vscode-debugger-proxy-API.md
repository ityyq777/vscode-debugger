# VSCode Debugger Proxy API 文档

## 概述

VSCode Debugger Proxy 是一个 VSCode 扩展，提供 HTTP API 控制调试器。Agent 通过调用这些接口来控制 VSCode 的调试会话。

**端口**: `4711`

---

## 健康检查

### `GET /health`

检查服务是否运行。

**响应**:
```json
{
  "status": "ok",
  "service": "vscode-debugger-proxy"
}
```

---

## 调试器状态

### `GET /status`

获取当前调试器状态。

**响应**:
```json
{
  "success": true,
  "active": true,
  "status": "stopped",
  "reason": "breakpoint",
  "file": "d:/path/to/file.py",
  "line": 29,
  "frameId": 4
}
```

| 字段 | 说明 |
|------|------|
| `active` | 调试器是否活动 |
| `status` | `running`, `stopped`, `terminated`, `timeout` |
| `reason` | `breakpoint`, `step`, `exception`, `entry` |
| `frameId` | 当前栈帧 ID（用于变量查询凭证） |

---

## 启动调试

### `POST /launch`

启动调试会话。

**请求体**:
```json
{
  "config": "Python: Flask"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `config` | 是 | launch.json 中的配置名称 |

**响应**:
```json
{
  "success": true,
  "message": "Debug session started. Call /wait to wait for debugger to stop."
}
```

**注意**: 如果调试器已启动，直接返回 `success: true`。

---

## 重新启动调试

### `POST /relaunch`

重新启动调试会话（先停止当前会话，再启动新会话）。

**请求体**:
```json
{
  "config": "Python: Flask"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `config` | 是 | launch.json 中的配置名称 |

**响应**:
```json
{
  "success": true,
  "message": "Debug session relaunched. Call /wait to wait for debugger to stop."
}
```

---

## 停止调试

### `POST /stop`

停止当前调试会话。

**响应**:
```json
{
  "success": true,
  "message": "Debug session stopped"
}
```

**注意**: 如果调试器已停止，直接返回 `success: true`。

---

## 等待断点

### `POST /wait`

阻塞等待调试器停止（断点命中或暂停）。

**查询参数**:
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `timeout` | int | 30000 | 超时毫秒数，`-1` 表示永久等待 |

**响应**:
```json
{
  "success": true,
  "status": "stopped",
  "reason": "breakpoint",
  "file": "d:/path/to/file.py",
  "line": 29,
  "frameId": 4,
  "message": "Stopped at d:/path/to/file.py:29 (breakpoint)"
}
```

**注意**: 必须先启动调试器（`/launch`）。

---

## 设置断点

### `POST /breakpoints`

设置断点。支持多文件批量设置。

**请求体**:
```json
{
  "d:/path/to/app.py": [29, 35],
  "d:/path/utils.py": [10, 15]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| key | 是 | 文件路径 |
| value | 是 | 行号数组（从 1 开始） |

**响应**:
```json
{
  "success": true,
  "breakpoints": {
    "d:/path/to/app.py": [29, 35],
    "d:/path/utils.py": [10, 15]
  },
  "message": "Breakpoints set: d:/path/to/app.py:29,35 d:/path/utils.py:10,15"
}
```

**注意**: 必须先启动调试器。

---

## 获取断点列表

### `GET /breakpoints`

获取所有当前设置的断点。

**响应**:
```json
{
  "success": true,
  "breakpoints": {
    "d:/path/to/app.py": [
      { "line": 29, "enabled": true },
      { "line": 35, "enabled": true }
    ],
    "d:/path/utils.py": [
      { "line": 10, "enabled": false }
    ]
  }
}
```

---

## 控制调试

### `POST /control`

执行调试控制命令。

**请求体**:
```json
{
  "action": "continue",
  "wait": true,
  "timeout": -1
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `action` | string | 必填 | `next`, `continue`, `stepIn`, `stepOut`, `pause`, `stop` |
| `wait` | bool | true | **仅 `continue` 有效**：是否等待下一个断点 |
| `timeout` | int | 30000 | **仅 `continue` 有效**：等待超时毫秒数，`-1` 表示永久等待 |

**注意**: `wait` 和 `timeout` 参数仅对 `continue` 动作生效。其他动作（`next`, `stepIn`, `stepOut`）执行单步后立即返回。

**响应（wait=true）**:
```json
{
  "success": true,
  "status": "stopped",
  "reason": "breakpoint",
  "file": "d:/path/to/file.py",
  "line": 35,
  "frameId": 7,
  "message": "Action 'continue' completed, paused at d:/path/to/file.py:35 (breakpoint)"
}
```

**响应（wait=false 或其他 action）**:
```json
{
  "success": true,
  "status": "stopped",
  "reason": "step",
  "file": "d:/path/to/file.py",
  "line": 30,
  "frameId": 5,
  "message": "Action 'next' executed, paused at d:/path/to/file.py:30"
}
```

**注意**: `next`, `stepIn`, `stepOut` 等单步动作执行后调试器会停止在单步后的位置，`reason` 为 `step`。只有 `continue` 动作命中断点时 `reason` 才是 `breakpoint`。

---

## 查看变量

### `POST /variables`

获取当前作用域的变量。

**请求体**:
```json
{
  "frameId": 4,
  "scope": {
    "Locals": ["user_id", "user"],
    "Globals": ["*"]
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `frameId` | int | 栈帧 ID（来自 `/wait` 返回） |
| `scope` | object | 作用域名称到变量名列表的映射 |
| `scope.*` | array | 变量名列表。如果为 `["*"]` 表示获取该作用域所有变量 |

**说明**:
- 如果 `scope` 字段不传，则默认返回 `Locals` 和 `Globals` 下所有变量
- 如果某个作用域的数组为 `["*"]`，则返回该作用域下所有变量
- 如果只指定了部分变量名，则只返回这些变量

**WARNING**: 不传 `scope` 字段是不推荐的。在大型代码库中，返回 `Locals` 和 `Globals` 下所有变量会造成巨大的网络传输负担。请尽量指定具体的变量名。

**响应**:
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

**响应（指定部分变量）**:
```json
{
  "success": true,
  "variables": {
    "Locals": {
      "user_id": "1"
    }
  },
  "frameId": 4
}
```

**frameId 校验**: 如果请求的 `frameId` 与当前调试器位置不一致，返回错误：

```json
{
  "success": false,
  "error": "Frame has changed. The debugger is no longer at the requested frame.",
  "currentFrame": {
    "frameId": 15,
    "file": "d:/path/to/file.py",
    "line": 40
  }
}
```

---

## 执行表达式

### `POST /evaluate`

在调试控制台执行表达式（类似于 VSCode 调试控制台 REPL）。

**请求体**:
```json
{
  "expression": "user_id + 10",
  "frameId": 4,
  "context": "repl"
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `expression` | string | 必填 | 要执行的表达式 |
| `frameId` | int | 当前帧 | 栈帧 ID（来自 `/wait` 返回） |
| `context` | string | `repl` | 上下文：`repl`, `watch`, `hover`, `variables` |

**响应**:
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

**响应（复杂对象）**:
```json
{
  "success": true,
  "result": "{'id': 1, 'name': 'Alice', 'email': 'alice@example.com'}",
  "type": "dict",
  "variablesReference": 7,
  "namedVariables": 3,
  "indexedVariables": 0
}
```

**说明**:
- 如果表达式返回的是复杂对象（字典、列表、对象等），`variablesReference > 0` 表示该对象包含子变量，可通过 `/variables` 接口获取详情
- `context` 参数影响表达式的求值方式：
  - `repl`: 调试控制台 REPL（推荐）。用于计算表达式和执行运算
  - `watch`: 监视表达式面板。用于添加或更新监视表达式
  - `hover`: 悬停提示框。用于悬停在代码上时显示信息
  - `variables`: 变量面板。用于调试窗格的变量区域

---

## 获取栈追踪

### `GET /stacktrace`

获取当前栈帧信息。

**响应**:
```json
{
  "success": true,
  "frame": {
    "id": 4,
    "name": "get_user",
    "file": "d:/path/to/file.py",
    "line": 29,
    "column": 1
  }
}
```

---

## 错误响应

所有接口的错误响应格式：

```json
{
  "success": false,
  "error": "错误描述信息"
}
```

| 状态码 | 说明 |
|--------|------|
| 400 | 请求参数错误或调试器未启动 |
| 404 | 文件不存在 |
| 500 | 服务器内部错误 |

---

## 调试器状态校验

以下接口会校验调试器状态：

| 接口 | 未启动行为 |
|------|-----------|
| `/breakpoints` (POST) | 返回 400 错误 |
| `/breakpoints` (GET) | 正常返回（无需调试器） |
| `/wait` | 返回 400 错误 |
| `/control` | 返回 400 错误 |
| `/variables` | 返回 400 错误 |
| `/evaluate` | 返回 400 错误 |
| `/stacktrace` | 返回 400 错误 |
| `/launch` | 正常启动 |
| `/relaunch` | 正常启动 |
| `/stop` | 返回 `success: true` |
| `/status` | 正常返回 |
| `/health` | 正常返回 |
