/**
 * =============================================================================
 * server.ts - HTTP 服务器模块
 * =============================================================================
 *
 * 核心职责：
 * 1. 启动 Express HTTP 服务器，提供 REST API
 * 2. 处理调试控制请求（启动/停止/单步调试）
 * 3. 处理断点管理请求
 * 4. 提供变量查询和表达式执行接口
 *
 * 为什么需要 HTTP Server：
 * - Claude Code Agent 运行在独立进程，无法直接调用 VSCode 扩展 API
 * - 通过 HTTP API，Agent 可以同步控制调试器（/wait 阻塞等待断点）
 * - 这使得 Agent 可以在断点处检查变量、执行表达式、然后决定下一步操作
 *
 * 数据流：
 * Agent HTTP 请求 -> Express 路由处理 -> VSCode API / StateManager -> 响应
 *
 * API 端点概览：
 * - /health        - 健康检查
 * - /status        - 获取调试器状态
 * - /launch        - 启动调试会话
 * - /relaunch      - 重新启动调试会话
 * - /stop          - 停止调试会话
 * - /wait          - 阻塞等待断点
 * - /control       - 控制调试（continue/step/next/...）
 * - /breakpoints   - 设置/获取断点
 * - /variables     - 获取变量
 * - /evaluate      - 执行表达式
 * - /stacktrace    - 获取栈追踪
 */

import express, { Express, Request, Response } from 'express';
import * as vscode from 'vscode';
import * as net from 'net';
import {
    waitForState,
    getCurrentState,
    resetState,
    getStackTrace,
    getVariables
} from './StateManager';

// =============================================================================
// 模块级变量
// =============================================================================

/** HTTP 服务器实例 */
let serverInstance: net.Server | null = null;

/** 当前分配的端口号 */
let currentPort: number | null = null;

/** Express 应用实例（路由配置） */
let appInstance: Express | null = null;

// =============================================================================
// 调试控制命令映射
// =============================================================================

// VSCode commands for debug control
const DEBUG_COMMANDS = {
    next: 'workbench.action.debug.stepOver',
    continue: 'workbench.action.debug.continue',
    stepIn: 'workbench.action.debug.stepInto',
    stepOut: 'workbench.action.debug.stepOut',
    pause: 'workbench.action.debug.pause',
    stop: 'workbench.action.debug.stop'
} as const;

export type DebugAction = keyof typeof DEBUG_COMMANDS;

interface LaunchRequest {
    config?: string;  // Name of the debug config in launch.json
}

// Breakpoints request format: { "file1.py": [10, 20], "file2.py": [5] }
type BreakpointsRequest = Record<string, number[]>;

interface ControlRequest {
    action: DebugAction;
    wait?: boolean;
    timeout?: number;
}

interface StackFrameResponse {
    id?: number;
    name?: string;
    file?: string;
    line?: number;
    column?: number;
}

// Port file location (relative to .vscode folder)
const PORT_FILE = '.vscode/debug-proxy.port';

/**
 * 检查调试器是否处于活动状态
 *
 * @returns true 表示调试器正在运行（可能暂停在断点），false 表示未启动或已终止
 */
function isDebuggerActive(): boolean {
    // 检查是否有活动的调试会话
    if (vscode.debug.activeDebugSession === undefined) {
        return false;
    }
    // 检查状态是否为终止或超时
    const state = getCurrentState();
    if (state.status === 'terminated' || state.status === 'timeout') {
        return false;
    }
    return true;
}

/**
 * 将端口号写入 .vscode/debug-proxy.port 文件
 *
 * 供外部进程（如 Claude Code）读取以获取服务器端口
 *
 * @param port - 端口号
 */
async function writePortFile(port: number): Promise<void> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            console.log('[Server] No workspace folder, skipping port file');
            return;
        }
        const portFilePath = vscode.Uri.joinPath(workspaceFolder.uri, PORT_FILE);
        await vscode.workspace.fs.writeFile(
            portFilePath,
            Buffer.from(port.toString(), 'utf8')
        );
        console.log(`[Server] Port ${port} written to ${portFilePath.fsPath}`);
    } catch (error) {
        console.error('[Server] Failed to write port file:', error);
    }
}

/**
 * 从 .vscode/debug-proxy.port 文件读取端口号
 *
 * @returns 端口号，如果文件不存在或读取失败返回 null
 */
export async function readPortFile(): Promise<number | null> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }
        const portFilePath = vscode.Uri.joinPath(workspaceFolder.uri, PORT_FILE);
        const content = await vscode.workspace.fs.readFile(portFilePath);
        return parseInt(content.toString(), 10);
    } catch {
        return null;
    }
}

/**
 * 设置 HTTP 服务器路由
 *
 * 仅配置 Express 路由，不绑定端口不启动服务器
 * 服务器启动由 startServer() 单独处理
 *
 * 为什么分离：
 * - startHttpServer() 创建 Express app 并注册所有路由（仅执行一次）
 * - startServer() 将 app 绑定到端口并开始监听（可多次调用实现开关）
 * - 这样每次点击"开关"不需要重新创建所有路由
 *
 * 端口配置流向：
 * - 用户配置的 port 在 startServer() 中使用
 * - 如果首选端口被占用，自动尝试 +1, +2, ...
 *
 * 注意：此函数仅调用一次，多次调用无效
 */
export function startHttpServer(context: vscode.ExtensionContext): void {
    // Only set up routes once
    if (appInstance) {
        console.log('[Server] HTTP server already initialized');
        return;
    }

    const config = vscode.workspace.getConfiguration('debuggerProxy');
    const defaultTimeout = config.get<number>('timeout', 30000);

    appInstance = express();
    appInstance.use(express.json());

    // Health check endpoint
    appInstance.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok', service: 'vscode-debugger-proxy' });
    });

    // =============================================================================
    // API 路由处理
    // =============================================================================

    // 获取调试器状态（非阻塞）
    // GET /status
    appInstance.get('/status', (_req: Request, res: Response) => {
        const state = getCurrentState();
        res.json({
            success: true,
            active: isDebuggerActive(),
            ...state
        });
    });

    // 设置断点
    // POST /breakpoints
    // 请求体: { "file1.py": [10, 20], "file2.py": [5] }
    appInstance.post('/breakpoints', async (req: Request, res: Response) => {

        const breakpointsMap = req.body as BreakpointsRequest;

        if (!breakpointsMap || typeof breakpointsMap !== 'object') {
            res.status(400).json({
                success: false,
                error: 'Invalid request: expected { "file": [lines] }'
            });
            return;
        }

        try {
            const newBreakpoints: vscode.Breakpoint[] = [];
            const results: Record<string, number[]> = {};

            for (const [file, lines] of Object.entries(breakpointsMap)) {
                if (!Array.isArray(lines)) {
                    continue;
                }

                const uri = vscode.Uri.file(file);

                // 验证文件是否存在
                try {
                    await vscode.workspace.fs.stat(uri);
                } catch {
                    res.status(404).json({
                        success: false,
                        error: `File not found: ${file}`
                    });
                    return;
                }

                // 为每一行创建断点
                for (const line of lines) {
                    const bp = new vscode.SourceBreakpoint(
                        new vscode.Location(uri, new vscode.Position(line - 1, 0))
                    );
                    newBreakpoints.push(bp);
                }

                results[file] = lines;
                console.log(`[Server] Breakpoints set at ${file}:${lines.join(',')}`);
            }

            vscode.debug.addBreakpoints(newBreakpoints);

            res.json({
                success: true,
                breakpoints: results,
                message: `Breakpoints set: ${Object.entries(results).map(([f, l]) => `${f}:${l.join(',')}`).join(', ')}`
            });

        } catch (error) {
            console.error('[Server] Failed to set breakpoints:', error);
            res.status(500).json({
                success: false,
                error: String(error)
            });
        }
    });

    // 等待调试器停止（阻塞）
    // POST /wait
    // 阻塞直到调试器停在断点或超时
    appInstance.post('/wait', async (req: Request, res: Response) => {
        // 检查调试器是否活动
        if (!isDebuggerActive()) {
            res.status(400).json({
                success: false,
                error: 'Debugger is not active. Start debugging first with /launch.'
            });
            return;
        }

        const timeout = req.query.timeout
            ? parseInt(req.query.timeout as string)
            : defaultTimeout;

        console.log('[Server] Waiting for debugger stop...');

        // 调用 StateManager 的 waitForState，阻塞等待
        const state = await waitForState('stopped', timeout);

        // 同步获取栈帧信息，确保位置正确
        // （DapTracker 的异步回调可能尚未完成，或调试目标已移动）
        if (state.status === 'stopped') {
            const frame = await getStackTrace(state.threadId);
            if (frame) {
                state.frameId = frame.id;
                state.file = frame.source?.path || frame.source?.name;
                state.line = frame.line;
            }
        }

        res.json({
            success: true,
            status: state.status,
            reason: state.reason,
            file: state.file,
            line: state.line,
            frameId: state.frameId,
            message: `Stopped at ${state.file || 'unknown'}:${state.line || '?'} (${state.reason})`
        });
    });

    // 启动调试会话
    // POST /launch
    // 请求体: { "config": "Python: Flask" }
    appInstance.post('/launch', async (req: Request, res: Response) => {
        const { config } = req.body as LaunchRequest;

        if (!config) {
            res.status(400).json({
                success: false,
                error: 'No config specified. Please provide a config name from launch.json'
            });
            return;
        }

        // 如果调试器已活动，直接返回成功
        if (isDebuggerActive()) {
            res.json({
                success: true,
                message: 'Debug session already active. Call /wait to wait for debugger to stop.'
            });
            return;
        }

        try {
            // 获取工作区文件夹
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

            // 启动前重置状态
            resetState();

            // 使用 launch.json 中的配置名称启动调试
            // VSCode 会查找配置并使用其设置
            await vscode.debug.startDebugging(workspaceFolder, config);

            console.log('[Server] Debug session started');

            res.json({
                success: true,
                message: 'Debug session started. Call /wait to wait for debugger to stop.'
            });

        } catch (error) {
            console.error('[Server] Failed to launch debug:', error);
            res.status(500).json({
                success: false,
                error: String(error)
            });
        }
    });

    // 调试控制（单步、继续、停止等）
    // POST /control
    // 请求体: { "action": "continue", "wait": true, "timeout": -1 }
    appInstance.post('/control', async (req: Request, res: Response) => {
        // 检查调试器是否活动
        if (!isDebuggerActive()) {
            res.status(400).json({
                success: false,
                error: 'Debugger is not active. Start debugging first with /launch.'
            });
            return;
        }

        const { action, wait = true } = req.body as ControlRequest;
        const timeout = req.body.timeout ?? (wait ? defaultTimeout : 0);

        // 验证 action 参数
        if (!action || !DEBUG_COMMANDS[action]) {
            res.status(400).json({
                success: false,
                error: `Invalid action: ${action}. Valid actions: ${Object.keys(DEBUG_COMMANDS).join(', ')}`
            });
            return;
        }

        try {
            // 执行调试命令（通过 VSCode 命令）
            await vscode.commands.executeCommand(DEBUG_COMMANDS[action]);

            // Only wait if wait=true (only for continue action)
            if (action == "continue" && wait) {
                // timeout=-1 means wait forever until stopped
                const actualTimeout = timeout === -1 ? 86400000 : timeout; // 24 hours as "forever"
                const finalState = await waitForState('stopped', actualTimeout);

                res.json({
                    success: true,
                    status: finalState.status,
                    reason: finalState.reason,
                    file: finalState.file,
                    line: finalState.line,
                    frameId: finalState.frameId,
                    message: `Action '${action}' completed, paused at ${finalState.file || '?'}:${finalState.line || '?'}`
                });
            } else {
                // 其他动作（next/stepIn/stepOut）或 wait=false 的 continue
                const currentState = getCurrentState();

                // 如果调试器正在运行（continue + wait=false），不获取栈帧
                if (currentState.status === 'running') {
                    res.json({
                        success: true,
                        status: currentState.status,
                        reason: currentState.reason,
                        message: `Action '${action}' executed, debugger is running`
                    });
                } else {
                    // 单步动作执行后，调试器会停止
                    const frame = await getStackTrace(currentState.threadId);

                    res.json({
                        success: true,
                        status: currentState.status,
                        reason: currentState.reason,
                        file: frame?.source?.path || currentState.file,
                        line: frame?.line || currentState.line,
                        frameId: frame?.id || currentState.frameId,
                        message: `Action '${action}' executed, paused at ${frame?.source?.path || '?'}:${frame?.line || '?'}`
                    });
                }
            }

        } catch (error) {
            console.error('[Server] Failed to execute control:', error);
            res.status(500).json({
                success: false,
                error: String(error)
            });
        }
    });

    // 获取变量
    // POST /variables
    // 请求体: { "frameId": 4, "scope": { "Locals": ["user_id"], "Globals": ["*"] } }
    appInstance.post('/variables', async (req: Request, res: Response) => {
        // 检查调试器是否活动
        if (!isDebuggerActive()) {
            res.status(400).json({
                success: false,
                error: 'Debugger is not active. Start debugging first with /launch.'
            });
            return;
        }

        // 解析请求体
        const { frameId, scope } = req.body as {
            frameId?: number;
            scope?: Record<string, string[]>;
        };

        // Validate frameId matches current stopped location
        const currentState = getCurrentState();
        console.log('[Server /variables] Request frameId:', frameId, 'currentState.frameId:', currentState.frameId);
        if (frameId !== undefined && currentState.frameId !== undefined) {
            if (Number(frameId) !== currentState.frameId) {
                res.json({
                    success: false,
                    error: 'Frame has changed. The debugger is no longer at the requested frame.',
                    currentFrame: {
                        frameId: currentState.frameId,
                        file: currentState.file,
                        line: currentState.line
                    }
                });
                return;
            }
        }

        try {
            const variables = await getVariables(scope, frameId);
            console.log('[Server /variables] getVariables returned:', JSON.stringify(variables));

            res.json({
                success: true,
                variables,
                frameId: frameId || currentState.frameId
            });
        } catch (error) {
            console.error('[Server] Failed to get variables:', error);
            res.status(500).json({
                success: false,
                error: String(error)
            });
        }
    });

    // 执行表达式（调试控制台 REPL）
    // POST /evaluate
    // 请求体: { "expression": "user_id + 10", "frameId": 4, "context": "repl" }
    interface EvaluateRequest {
        expression: string;
        frameId?: number;
        context?: 'watch' | 'repl' | 'hover' | 'variables';
    }

    appInstance.post('/evaluate', async (req: Request, res: Response) => {
        // 检查调试器是否活动
        if (!isDebuggerActive()) {
            res.status(400).json({
                success: false,
                error: 'Debugger is not active. Start debugging first with /launch.'
            });
            return;
        }

        const { expression, frameId, context = 'repl' } = req.body as EvaluateRequest;

        if (!expression || typeof expression !== 'string') {
            res.status(400).json({
                success: false,
                error: 'Invalid request: expected { "expression": "..." }'
            });
            return;
        }

        const currentState = getCurrentState();
        const effectiveFrameId = frameId || currentState.frameId;

        try {
            const session = vscode.debug.activeDebugSession;
            if (!session) {
                res.status(400).json({
                    success: false,
                    error: 'No active debug session'
                });
                return;
            }

            console.log(`[Server /evaluate] Evaluating: ${expression} (frameId: ${effectiveFrameId}, context: ${context})`);

            // 向调试器发送 DAP evaluate 请求
            const result = await session.customRequest('evaluate', {
                expression,
                frameId: effectiveFrameId,
                context
            });

            console.log(`[Server /evaluate] Result:`, JSON.stringify(result));

            res.json({
                success: true,
                result: result.result,
                type: result.type,
                variablesReference: result.variablesReference,
                namedVariables: result.namedVariables,
                indexedVariables: result.indexedVariables
            });

        } catch (error) {
            console.error('[Server] Failed to evaluate expression:', error);
            res.status(500).json({
                success: false,
                error: String(error)
            });
        }
    });

    // Get stack trace
    appInstance.get('/stacktrace', async (_req: Request, res: Response) => {
        // Check debugger is active
        if (!isDebuggerActive()) {
            res.status(400).json({
                success: false,
                error: 'Debugger is not active. Start debugging first with /launch.'
            });
            return;
        }

        try {
            // Use currentState.threadId directly if available
            const frame = await getStackTrace(getCurrentState().threadId);
            if (frame) {
                const frameResponse: StackFrameResponse = {
                    id: frame.id,
                    name: frame.name,
                    file: frame.source?.path,
                    line: frame.line,
                    column: frame.column
                };
                res.json({
                    success: true,
                    frame: frameResponse
                });
            } else {
                res.json({
                    success: true,
                    frame: null,
                    message: 'No active stack frame'
                });
            }
        } catch (error) {
            console.error('[Server] Failed to get stack trace:', error);
            res.status(500).json({
                success: false,
                error: String(error)
            });
        }
    });

    // Relaunch debugging (stop then start)
    appInstance.post('/relaunch', async (req: Request, res: Response) => {
        const { config } = req.body as LaunchRequest;

        if (!config) {
            res.status(400).json({
                success: false,
                error: 'No config specified. Please provide a config name from launch.json'
            });
            return;
        }

        try {
            // Stop existing session if active
            if (isDebuggerActive()) {
                await vscode.commands.executeCommand('workbench.action.debug.stop');
                // Wait a bit for cleanup
                await new Promise(r => setTimeout(r, 500));
            }

            // Reset state
            resetState();

            // Get workspace folder
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

            // Start debugging
            await vscode.debug.startDebugging(workspaceFolder, config);

            console.log('[Server] Debug session relaunched with config:', config);

            res.json({
                success: true,
                message: 'Debug session relaunched. Call /wait to wait for debugger to stop.'
            });

        } catch (error) {
            console.error('[Server] Failed to relaunch debug:', error);
            res.status(500).json({
                success: false,
                error: String(error)
            });
        }
    });

    // Get all breakpoints
    appInstance.get('/breakpoints', async (_req: Request, res: Response) => {
        try {
            const allBreakpoints = vscode.debug.breakpoints;

            // Group breakpoints by file
            const breakpointsByFile: Record<string, Array<{
                line: number;
                enabled: boolean;
            }>> = {};

            for (const bp of allBreakpoints) {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const uri = bp.location.uri;
                    const filePath = uri.fsPath;
                    const line = bp.location.range.start.line + 1; // Convert to 1-indexed

                    if (!breakpointsByFile[filePath]) {
                        breakpointsByFile[filePath] = [];
                    }
                    breakpointsByFile[filePath].push({
                        line,
                        enabled: bp.enabled
                    });
                }
            }

            res.json({
                success: true,
                breakpoints: breakpointsByFile
            });

        } catch (error) {
            console.error('[Server] Failed to get breakpoints:', error);
            res.status(500).json({
                success: false,
                error: String(error)
            });
        }
    });

    // Stop debugging
    appInstance.post('/stop', async (_req: Request, res: Response) => {
        // If debugger not active, return success
        if (!isDebuggerActive()) {
            res.json({
                success: true,
                message: 'Debug session not active'
            });
            return;
        }

        try {
            await vscode.commands.executeCommand('workbench.action.debug.stop');
            resetState();
            res.json({
                success: true,
                message: 'Debug session stopped'
            });
        } catch (error) {
            console.error('[Server] Failed to stop debug:', error);
            res.status(500).json({
                success: false,
                error: String(error)
            });
        }
    });
}

/**
 * Start the HTTP server (call after setupRoutes).
 *
 * 首先尝试使用配置的端口，如果被占用则自动查找下一个可用端口。
 */
export async function startServer(): Promise<number> {
    if (serverInstance) {
        console.log('[Server] HTTP server already running on port', currentPort);
        return currentPort!;
    }

    const config = vscode.workspace.getConfiguration('debuggerProxy');
    const preferredPort = config.get<number>('port', 4711);

    return new Promise((resolve, reject) => {
        const tryListen = (port: number) => {
            serverInstance = appInstance!.listen(port, () => {
                currentPort = port;
                console.log(`[Server] VSCode Debugger Proxy listening on port ${currentPort}`);
                writePortFile(currentPort);
                // vscode的右下角弹窗提示
                vscode.window.showInformationMessage(
                    `Debugger Proxy listening on http://localhost:${currentPort}`
                );
                resolve(currentPort);
            });

            serverInstance.on('error', (error: NodeJS.ErrnoException) => {
                if (error.code === 'EADDRINUSE') {
                    console.log(`[Server] Port ${port} is in use, trying ${port + 1}...`);
                    tryListen(port + 1);
                } else {
                    console.error('[Server] Server error:', error);
                    reject(error);
                }
            });
        };

        tryListen(preferredPort);
    });
}

/**
 * Stop the HTTP server.
 */
export function stopServer(): void {
    if (serverInstance) {
        serverInstance.close();
        serverInstance = null;
        currentPort = null;
        console.log('[Server] VSCode Debugger Proxy stopped');
    } else {
        console.log('[Server] HTTP server not running');
    }
}

/**
 * Check if the HTTP server is running.
 */
export function isServerRunning(): boolean {
    return serverInstance !== null;
}

/**
 * Get the current server port.
 */
export function getServerPort(): number | null {
    return currentPort;
}
