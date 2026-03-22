---
name: vscode-debugger
description: Control VSCode debugger via HTTP API. Use when asked to debug code, inspect variables, step through functions, or analyze runtime behavior. This skill enables synchronous blocking debug operations through a local HTTP proxy.
user-invocable: true
---
# VSCode Debugger Proxy

A synchronous blocking proxy to control the VSCode debugger. This tool allows you to debug code by sending HTTP requests that wait for debugger state changes.

## Critical Concepts

### Port Discovery
**IMPORTANT**: The proxy port is auto-assigned. Before connecting, you MUST read the port file:

```
.read file: .vscode/debug-proxy.port
```

Use the port number from this file as the base URL (e.g., `http://localhost:xxxx`)

### Self-Triggering Breakpoints (Deadlock Risk)
If you can only run one terminal/agent, do NOT send HTTP requests to the debugged service (e.g., `curl http://127.0.0.1:5000/users/1`). This will cause a **deadlock** because you're blocking the terminal while waiting for a response from the same terminal. Use `/wait` and let the user or an external process trigger the breakpoint. Only multi-terminal agents can safely trigger breakpoints themselves.

### Synchronous Blocking
When you send commands like `next`, `continue`, or `wait`, the HTTP request **BLOCKS** until the debugger pauses (e.g., hits a breakpoint, completes a step, or times out). Do not assume it failed if it takes time - this is expected.

### FrameId as Credential
The `frameId` returned by `/wait` is a credential. All subsequent requests (`/variables`, `/evaluate`, `/control`) should include this `frameId`. If the debugger state changes (e.g., user manually continues), the proxy will return an error.

### Two Debugger States
- `running`: Debugger is executing code
- `stopped`: Debugger is paused (at breakpoint, after step, etc.)

---

## Endpoints

### 1. Health Check
- **Endpoint**: `GET /health`
- **Blocking**: No
- **Returns**: `{ "status": "ok", "service": "vscode-debugger-proxy" }`

### 2. Get Debug Status
- **Endpoint**: `GET /status`
- **Blocking**: No
- **Returns**:
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

### 3. Set Breakpoints
- **Endpoint**: `POST /breakpoints`
- **Blocking**: No
- **Request Body** (Map format - supports multiple files):
```json
{
  "/absolute/path/to/app.py": [29, 30],
  "/absolute/path/to/utils.py": [10, 15]
}
```
- **Returns**:
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

### 4. Get Breakpoints
- **Endpoint**: `GET /breakpoints`
- **Description**: Get all currently set breakpoints
- **Blocking**: No
- **Returns**:
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

### 5. Launch Debugging
- **Endpoint**: `POST /launch`
- **Description**: Start a debug session using a configuration name from launch.json
- **Blocking**: **Yes** - waits until debugger stops at entry or first breakpoint
- **Request Body**:
```json
{
  "config": "Python: Flask"
}
```
- **Note**: The `config` value must match a configuration name defined in your `launch.json`
- **Returns**:
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

### 6. Relaunch Debugging
- **Endpoint**: `POST /relaunch`
- **Description**: Stop current session and start a new one (equivalent to stop + launch)
- **Blocking**: **Yes** - same as `/launch`
- **Request Body**:
```json
{
  "config": "Python: Flask"
}
```

### 7. Wait for Debugger Stop
- **Endpoint**: `POST /wait`
- **Description**: Block until debugger stops (breakpoint hit, step completed, etc.)
- **Blocking**: **Yes** - waits until debugger pauses or timeout
- **Query Param**: `timeout` (ms, default: 30000, use -1 for infinite)
- **Returns**:
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

### 8. Debug Control (Step/Continue)
- **Endpoint**: `POST /control`
- **Description**: Control debugger execution
- **Blocking**: Depends on action and `wait` parameter
- **Request Body**:
```json
{
  "action": "next" | "continue" | "stepIn" | "stepOut",
  "wait": true,
  "timeout": -1
}
```
- **Actions**:
  - `next`: Step over (execute current line, stop at next)
  - `continue`: Continue execution until next breakpoint
  - `stepIn`: Step into function call
  - `stepOut`: Step out of current function
- **Parameters**:
  - `wait`: Only effective for `continue`. If `true`, blocks until next breakpoint. If `false`, returns immediately.
  - `timeout`: Only effective for `continue` with `wait=true`. Use `-1` for infinite wait.
- **Returns**:
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

### 9. Get Variables
- **Endpoint**: `POST /variables`
- **Description**: Get current scope variables
- **Blocking**: No
- **Request Body**:
```json
{
  "frameId": 4,
  "scope": {
    "Locals": ["user_id", "user"],
    "Globals": ["*"]
  }
}
```
- **Fields**:
  - `frameId`: The frameId from `/wait` response (acts as credential)
  - `scope`: Optional, mapping of scope name to variable list. Use `["*"]` for all variables in that scope. If omitted, returns all variables from all scopes.
- **FrameId Validation**: If the debugger has moved to a different frame, returns error:
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
- **Returns**:
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
- **Note**: If `scope` is not provided, returns all variables from both Locals and Globals scopes.
- **WARNING**: Omitting `scope` is NOT recommended for large applications. Returning all variables from both Locals and Globals can cause significant network transfer overhead and slow down debugging in large codebases. Always specify the exact variables you need when possible.

### 10. Evaluate Expression
- **Endpoint**: `POST /evaluate`
- **Description**: Execute an expression in the debug console REPL
- **Blocking**: No
- **Request Body**:
```json
{
  "expression": "user_id + 10",
  "frameId": 4,
  "context": "repl"
}
```
- **Fields**:
  - `expression`: Required. The expression to evaluate
  - `frameId`: Optional, defaults to current frame. The frameId from `/wait` response
  - `context`: Optional, defaults to `repl`. One of: `repl`, `watch`, `hover`, `variables`
- **Returns**:
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
- **Note**: If the expression returns a complex object (dict, list, object), `variablesReference > 0` indicates child variables that can be retrieved via `/variables`.

**`context` parameter values**:
- `repl` (default): Debug console REPL. Use this for evaluating expressions and computations.
- `watch`: Watch expression panel. Adds or updates a watch expression.
- `hover`: Hover tooltip. Used when hovering over code.
- `variables`: Variables panel. Used in the VARIABLES section of the debug pane.

**Recommendation**: Use `repl` context for most cases. The other contexts are specialized for their respective VSCode UI panels.

### 11. Get Stack Trace
- **Endpoint**: `GET /stacktrace`
- **Description**: Get current call stack frame info
- **Blocking**: No
- **Returns**:
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

### 12. Stop Debugging
- **Endpoint**: `POST /stop`
- **Blocking**: No
- **Returns**:
```json
{
  "success": true,
  "message": "Debug session stopped"
}
```

---

## Workflow Examples

### Standard Debugging Workflow

```bash
# 1. Set breakpoints (can be done before or after launching)
curl -X POST http://localhost:4711/breakpoints \
  -H "Content-Type: application/json" \
  -d '{"d:/project/app.py": [29]}'

# 2. Launch debug (BLOCKS until debugger stops)
curl -X POST http://localhost:4711/launch \
  -H "Content-Type: application/json" \
  -d '{"config": "Python: Flask"}'

# Response: { "status": "stopped", "reason": "entry", "frameId": 3, ... }

# 3. Wait for breakpoint (BLOCKS until breakpoint hit)
curl -X POST http://localhost:4711/wait -H "Content-Type: application/json"

# 4. Get variables (use frameId from wait response)
curl -X POST http://localhost:4711/variables \
  -H "Content-Type: application/json" \
  -d '{"frameId": 4, "scope": {"Locals": ["*"], "Globals": ["*"]}}'

# 5. Evaluate expression (e.g., check calculation result)
curl -X POST http://localhost:4711/evaluate \
  -H "Content-Type: application/json" \
  -d '{"expression": "user_id + 10", "frameId": 4}'

# 6. Step through code
curl -X POST http://localhost:4711/control \
  -H "Content-Type: application/json" \
  -d '{"action": "next"}'

# 7. Continue to next breakpoint (BLOCKS)
curl -X POST http://localhost:4711/control \
  -H "Content-Type: application/json" \
  -d '{"action": "continue", "wait": true, "timeout": -1}'
```

### Debug a Logic Error

**Goal**: Debug why variable `i` never resets in a loop

```bash
# Step 1: Set breakpoint at suspected line
curl -X POST http://localhost:4711/breakpoints \
  -H "Content-Type: application/json" \
  -d '{"d:/project/loop.py": [10]}'

# Step 2: Launch debug (BLOCKS at entry)
curl -X POST http://localhost:4711/launch \
  -H "Content-Type: application/json" \
  -d '{"config": "Python: Current File"}'

# Step 3: Wait for breakpoint
curl -X POST http://localhost:4711/wait -H "Content-Type: application/json"
# Response: { "frameId": 4, "line": 10, ... }

# Step 4: Check variable value
curl -X POST http://localhost:4711/variables \
  -H "Content-Type: application/json" \
  -d '{"frameId": 4, "scope": {"Locals": ["i", "max"]}}'
# Response: { "variables": { "Locals": { "i": 100, "max": 10 } } }

# Step 5: Evaluate expression to understand behavior
curl -X POST http://localhost:4711/evaluate \
  -H "Content-Type: application/json" \
  -d '{"expression": "i - max", "frameId": 4}'
# Response: { "result": "90", "type": "int" }

# Step 6: Step through to observe behavior
curl -X POST http://localhost:4711/control \
  -H "Content-Type: application/json" \
  -d '{"action": "next"}'
# Response: { "line": 11, "frameId": 5, ... }
# i is now 101 - increments without reset

# Step 7: Analyze and suggest fix
```

---

## Error Handling

### Timeout
If a blocking operation times out:
```json
{
  "success": true,
  "status": "timeout",
  "reason": "timeout",
  "message": "Debug operation timed out"
}
```
**Actions**:
1. Send `POST /control { "action": "continue", "wait": true }` to continue to next breakpoint
2. Send `POST /stop` to terminate the debug session

### Frame Changed Error
If user manually continues or steps, your frameId becomes invalid:
```json
{
  "success": false,
  "error": "Frame has changed. The debugger is no longer at the requested frame.",
  "currentFrame": { "frameId": 15, "file": "...", "line": 40 }
}
```
**Action**: Call `/wait` again to get the new debugger state.

### No Active Debug Session
```json
{
  "success": false,
  "error": "Debugger is not active. Start debugging first with /launch."
}
```

---

## Important Notes

1. **Line numbers are 1-indexed**: The API uses human-readable line numbers (starting from 1).

2. **Use absolute paths**: File paths in requests should be absolute paths.

3. **frameId is your checkpoint**: Always include the `frameId` from `/wait` in subsequent requests. This ensures you're still at the same debugging location.

4. **Blocking is normal**: Do not retry or show error messages if a request takes longer than expected. The debugger is simply waiting.

5. **Multiple files supported**: The breakpoints format supports setting breakpoints in multiple files at once using the Map format.

6. **Keep debugger running**: Do NOT stop the debugger (`/stop`) after finding useful information. Starting a large system can be very time-consuming (seconds to minutes). Keep the debugger running and continue debugging as needed. Only stop when you are completely finished debugging or need to restart the application.
