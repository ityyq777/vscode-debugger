# VSCode Debugger Proxy

Enable Claude Code (Agent) to control the VSCode debugger via synchronous blocking HTTP API.

## What It Does

- Agent sends HTTP requests to control debugger (set breakpoints, step through code, inspect variables)
- Requests block until breakpoint is hit - no polling needed
- Uses frameId as credential to detect user interference

## Components

### vscode-debugger-proxy (VSCode Extension)

Located in `vscode-debugger-proxy/`.

Provides HTTP API for debugger control:
- Start/stop debug sessions
- Set/manage breakpoints
- Block on `/wait` until breakpoint hit
- Step execution (next, stepIn, stepOut, continue)
- Get variables and evaluate expressions
- Get stack trace

### vscode-debugger (Agent Skill)

Located in `agent/skills/vscode-debugger/`.

Defines how Agent should call the proxy API:
- `SKILL.md` - English version
- `SKILL-ZH.md` - Chinese version

## Quick Start

### 1. Install Extension

```bash
cd vscode-debugger-proxy
npm install
npm run compile
# Press F5 in VSCode to debug the extension
```

Or package and install locally:
```bash
vsce package
code --install-extension vscode-debugger-proxy-0.1.0.vsix
```

### 2. Start Proxy Server

Click the `vdp ×` button in VSCode status bar, or set `debuggerProxy.autoStart: true` in settings.

### 3. Agent Connects

```bash
# Read port file
PORT=$(cat .vscode/debug-proxy.port)

# Check health
curl http://localhost:$PORT/health
```

## API Overview

| Endpoint | Method | Blocking | Description |
|----------|--------|----------|-------------|
| `/health` | GET | No | Health check |
| `/status` | GET | No | Get debugger status |
| `/launch` | POST | **Yes** | Start debug session |
| `/wait` | POST | **Yes** | Block until breakpoint |
| `/control` | POST | **Yes** | Step/continue |
| `/breakpoints` | POST | No | Set breakpoints |
| `/variables` | POST | No | Get variables |
| `/evaluate` | POST | No | Evaluate expression |
| `/stacktrace` | GET | No | Get stack trace |

See [API documentation](docs/vscode-debugger-proxy-API.md) for details.

## Documentation

| Category | Document | Description |
|----------|----------|-------------|
| User | [Configuration Guide](docs/vscode-debugger-proxy-配置.md) | Settings, status bar |
| | [Debug Guide](docs/vscode-debugger-proxy-调试.md) | curl/PowerShell examples |
| Developer | [API Docs](docs/vscode-debugger-proxy-API.md) | All API endpoints |
| | [Architecture](docs/架构文档.md) | System design, state machine |
| | [Development](docs/开发方案.md) | Design patterns, code samples |
| Agent | [SKILL.md](agent/skills/vscode-debugger/SKILL.md) | Agent skill (EN) |
| | [SKILL-ZH.md](agent/skills/vscode-debugger/SKILL-ZH.md) | Agent skill (ZH) |

## Project Structure

```
vscode-debugger/
├── vscode-debugger-proxy/          # VSCode extension
│   └── src/
│       ├── extension.ts           # Entry point, status bar
│       ├── server.ts              # HTTP server, API routes
│       ├── StateManager.ts        # State management
│       └── DapTracker.ts          # DAP event interceptor
├── agent/skills/vscode-debugger/   # Agent skill definitions
├── docs/                           # Documentation
└── test/
    └── test-flask-app/             # Test Flask app
```
