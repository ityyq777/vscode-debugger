# VSCode Debugger Proxy

让 Claude Code（Agent）通过同步阻塞式 HTTP API 控制 VSCode 调试器。

## 核心功能

- Agent 发送 HTTP 请求控制调试器（设置断点、单步执行、检查变量）
- 请求会阻塞直到断点命中 - 无需轮询
- 使用 frameId 作为凭证检测用户干预

## 组成部分

### vscode-debugger-proxy（VSCode 扩展插件）

位于 `vscode-debugger-proxy/`。

提供调试器控制的 HTTP API：
- 启动/停止调试会话
- 设置/管理断点
- `/wait` 阻塞等待断点命中
- 单步执行（next、stepIn、stepOut、continue）
- 获取变量和执行表达式
- 获取栈追踪

### vscode-debugger（Agent Skill）

位于 `agent/skills/vscode-debugger/`。

定义 Agent 如何调用代理 API：
- `SKILL.md` - 英文版
- `SKILL-ZH.md` - 中文版

## 快速开始

### 1. 安装扩展

```bash
cd vscode-debugger-proxy
npm install
npm run compile
# 在 VSCode 中按 F5 调试扩展
```

或打包后本地安装：
```bash
vsce package
code --install-extension vscode-debugger-proxy-0.1.0.vsix
```

### 2. 启动代理服务器

点击 VSCode 底部状态栏左侧的 `vdp ×` 按钮，或在设置中启用 `debuggerProxy.autoStart: true`。

### 3. Agent 连接

```bash
# 读取端口文件
PORT=$(cat .vscode/debug-proxy.port)

# 健康检查
curl http://localhost:$PORT/health
```

## API 概览

| 接口 | 方法 | 阻塞 | 说明 |
|------|------|------|------|
| `/health` | GET | 否 | 健康检查 |
| `/status` | GET | 否 | 获取调试器状态 |
| `/launch` | POST | **是** | 启动调试会话 |
| `/wait` | POST | **是** | 阻塞等待断点 |
| `/control` | POST | **是** | 单步/继续 |
| `/breakpoints` | POST | 否 | 设置断点 |
| `/variables` | POST | 否 | 获取变量 |
| `/evaluate` | POST | 否 | 执行表达式 |
| `/stacktrace` | GET | 否 | 获取栈追踪 |

详见 [API 文档](docs/vscode-debugger-proxy-API.md)。

## 文档目录

| 类别 | 文档 | 说明 |
|------|------|------|
| 用户 | [配置指南](docs/vscode-debugger-proxy-配置.md) | 配置项、状态栏 |
| | [调试指南](docs/vscode-debugger-proxy-调试.md) | curl/PowerShell 示例 |
| 开发者 | [API 文档](docs/vscode-debugger-proxy-API.md) | 所有 API 接口 |
| | [架构文档](docs/架构文档.md) | 系统架构、状态机 |
| | [开发方案](docs/开发方案.md) | 设计模式、代码示例 |
| Agent | [SKILL.md](agent/skills/vscode-debugger/SKILL.md) | Skill 英文版 |
| | [SKILL-ZH.md](agent/skills/vscode-debugger/SKILL-ZH.md) | Skill 中文版 |

## 项目结构

```
vscode-debugger/
├── vscode-debugger-proxy/          # VSCode 扩展插件
│   └── src/
│       ├── extension.ts           # 入口、状态栏
│       ├── server.ts              # HTTP 服务器、API 路由
│       ├── StateManager.ts        # 状态管理
│       └── DapTracker.ts          # DAP 事件拦截器
├── agent/skills/vscode-debugger/   # Agent Skill 定义
├── docs/                           # 文档
└── test/
    └── test-flask-app/             # 测试用 Flask 应用
```
