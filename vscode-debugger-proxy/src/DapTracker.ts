import * as vscode from 'vscode';
import { updateState, DebugState } from './StateManager';

/**
 * =============================================================================
 * DapTracker - 调试适配器协议（DAP）事件拦截器
 * =============================================================================
 *
 * 核心职责：
 * 1. 监听并拦截 VSCode 与调试器之间的 DAP 协议消息
 * 2. 检测用户对调试器的操作行为（继续、单步、停止等）
 * 3. 检测调试器状态变化（断点命中、异常、单步完成等）
 * 4. 将这些事件同步到 StateManager，供 HTTP Server 响应给 Agent
 *
 * 为什么需要 DapTracker：
 * - VSCode 调试 API 本身不提供直接的回调机制来感知"断点命中"
 * - 通过拦截 DAP 协议消息，我们可以获取：
 *   a) 调试器何时停止（stopped 事件）
 *   b) 停止的原因（breakpoint、step、exception 等）
 *   c) 当前的堆栈帧信息（file、line、frameId）
 *
 * 用户操作 -> DapTracker 检测 -> StateManager 更新 -> Agent 感知
 */

// =============================================================================
// 主要函数
// =============================================================================

/**
 * 创建调试适配器跟踪器
 *
 * @returns vscode.DebugAdapterTracker - 一个拦截 DAP 消息的跟踪器对象
 */
export function createDapTracker(): vscode.ProviderResult<vscode.DebugAdapterTracker> {
    return {
        // =========================================================================
        // 会话生命周期事件
        // =========================================================================

        /**
         * 调试会话即将开始
         * 触发时机：用户按 F5 或通过命令启动调试时
         */
        onWillStartSession: () => {
            console.log('[DapTracker] Debug session starting');
            // 通知状态管理器：调试器已启动，状态为 running
            updateState({ status: 'running' });
        },

        /**
         * 调试会话即将结束
         * 触发时机：用户点击停止按钮或调试程序正常退出时
         */
        onWillStopSession: () => {
            console.log('[DapTracker] Debug session stopping');
            // 通知状态管理器：调试器已停止，状态为 terminated
            updateState({ status: 'terminated' });
        },

        // =========================================================================
        // DAP 协议消息拦截
        // =========================================================================

        /**
         * VSCode 向调试器发送消息后，会触发此回调
         * 这是拦截 DAP 事件的核心入口
         *
         * @param message - DAP 协议消息对象
         *
         * DAP 事件类型说明：
         * - stopped: 调试器停止运行（断点命中、单步完成、异常等）
         * - continued: 调试器恢复运行（点击继续/单步后）
         * - terminated: 调试会话结束
         * - exited: 调试进程退出
         * - thread: 线程事件（创建/退出）
         */
        onDidSendMessage: (message: any) => {
            // -------------------- stopped 事件 --------------------
            // 触发时机：
            // 1. 程序命中断点
            // 2. 用户执行单步操作（next/stepIn/stepOut）后
            // 3. 抛出异常
            // 4. 用户点击暂停按钮
            if (message.event === 'stopped') {
                const body = message.body || {};

                // 构建停止状态对象
                const stoppedState: Partial<DebugState> = {
                    status: 'stopped',
                    reason: body.reason,        // 停止原因: 'breakpoint', 'step', 'exception', 'entry'
                    threadId: body.threadId,    // 触发停止的线程 ID
                    allThreadsStopped: body.allThreadsStopped  // 是否所有线程都停止
                };

                // 向 VSCode 查询当前停止位置（文件名、行号、帧 ID）
                // 这是获取"断点命中位置"的关键
                const session = vscode.debug.activeDebugSession;
                if (session) {
                    Promise.resolve(session.customRequest('stackTrace', { threadId: body.threadId }))
                        .then((response: any) => {
                            // DAP stackTrace 响应格式: { stackFrames: [...] } 或 { body: { stackFrames: [...] } }
                            const frames = response?.body?.stackFrames || response?.stackFrames;
                            if (frames && frames.length > 0) {
                                const frame = frames[0];  // 取第一帧（当前执行位置）
                                updateState({
                                    file: frame.source?.path || frame.source?.name,  // 文件路径
                                    line: frame.line,        // 行号（1-indexed）
                                    frameId: frame.id        // 帧 ID（用于变量查询凭证）
                                });
                                console.log(`[DapTracker] Stopped at ${frame.source?.path}:${frame.line} (${body.reason})`);
                            } else {
                                console.log(`[DapTracker] Stopped: reason=${body.reason}, threadId=${body.threadId}`);
                            }
                        })
                        .catch((err: any) => {
                            console.log(`[DapTracker] stackTrace error: ${err}, reason=${body.reason}, threadId=${body.threadId}`);
                        });
                }

                // 更新基本停止状态
                updateState(stoppedState);

            // -------------------- continued 事件 --------------------
            // 触发时机：用户点击"继续"按钮或执行单步后程序恢复运行
            } else if (message.event === 'continued') {
                console.log(`[DapTracker] Continued: threadId=${message.body?.threadId}`);
                updateState({ status: 'running' });

            // -------------------- terminated 事件 --------------------
            // 触发时机：调试会话被强制终止（用户点击停止，或会话结束）
            } else if (message.event === 'terminated') {
                console.log(`[DapTracker] Terminated event received`);
                updateState({ status: 'terminated' });

            // -------------------- exited 事件 --------------------
            // 触发时机：被调试的进程退出（正常或异常退出）
            } else if (message.event === 'exited') {
                console.log(`[DapTracker] Process exited: code=${message.body?.exitCode}`);
                updateState({ status: 'terminated' });

            // -------------------- thread 事件 --------------------
            // 触发时机：线程创建或退出（多线程调试时）
            } else if (message.event === 'thread') {
                if (message.body.reason === 'started') {
                    console.log(`[DapTracker] Thread started: ${message.body.threadId}`);
                } else if (message.body.reason === 'exited') {
                    console.log(`[DapTracker] Thread exited: ${message.body.threadId}`);
                }

            // -------------------- stackTrace 响应 --------------------
            // 这是对之前请求 stackTrace 的响应，用于缓存堆栈信息
            } else if (message.type === 'response' && message.command === 'stackTrace') {
                if (message.body && message.body.stackFrames && message.body.stackFrames.length > 0) {
                    const topFrame = message.body.stackFrames[0];
                    if (topFrame.source) {
                        updateState({
                            file: topFrame.source.path || topFrame.source.name,
                            line: topFrame.line
                        });
                    }
                }
            }

            // -------------------- stderr 输出 --------------------
            // 捕获调试器的错误输出（有助于调试异常）
            if (message.event === 'output' && message.body?.category === 'stderr') {
                console.log(`[DapTracker] stderr: ${message.body.output}`);
            }
        },

        // =========================================================================
        // 错误处理
        // =========================================================================

        /**
         * 调试适配器发生错误
         * 触发时机：调试进程崩溃、通信错误等
         */
        onError: (error: Error) => {
            console.error(`[DapTracker] Error: ${error.message}`);
            updateState({ status: 'terminated' });
        }
    };
}

// =============================================================================
// 注册函数
// =============================================================================

/**
 * 向 VSCode 注册调试适配器跟踪器工厂
 *
 * 注册后，所有调试会话都会自动使用 createDapTracker() 创建的跟踪器
 * '*' 表示匹配所有调试类型（Python、Node、Chrome 等）
 *
 * @param context - VSCode 扩展上下文
 */
export function registerDapTracker(context: vscode.ExtensionContext): void {
    const factory = vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(session: vscode.DebugSession) {
            return createDapTracker();
        }
    });

    // 将工厂注册到扩展订阅中，确保扩展卸载时清理
    context.subscriptions.push(factory);
    console.log('[DapTracker] Debug adapter tracker factory registered');
}
