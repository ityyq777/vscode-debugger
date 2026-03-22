/**
 * =============================================================================
 * StateManager - 调试状态管理器
 * =============================================================================
 *
 * 核心职责：
 * 1. 维护调试器的当前状态（running、stopped、terminated、timeout）
 * 2. 提供阻塞式等待状态变化的接口（供 HTTP Server 调用）
 * 3. 缓存调试器停止位置（file、line、frameId、threadId）
 * 4. 提供栈帧信息和变量查询接口
 *
 * 为什么需要 StateManager：
 * - HTTP Server 需要知道调试器当前状态，但 Node.js/Express 是异步的
 * - 当 Agent 调用 /wait 接口时，需要阻塞等待直到调试器停在某个断点
 * - StateManager 通过 Promise + Resolver 模式实现阻塞等待
 *
 * 数据流：
 * DapTracker 检测 DAP 事件 -> updateState() 更新状态 -> Resolver 被触发 -> /wait 返回
 *
 * 使用方式：
 * - /wait 调用 waitForState('stopped') 阻塞等待
 * - DapTracker 调用 updateState({ status: 'stopped', reason: 'breakpoint', ... }) 通知状态变化
 * - waitForState 内部检测到状态匹配，resolve Promise，/wait 返回结果
 */

import * as vscode from 'vscode';

// =============================================================================
// 类型定义
// =============================================================================

/**
 * 调试器状态类型
 */
export type DebugStatus = 'running' | 'stopped' | 'terminated' | 'timeout';

/**
 * 调试状态完整结构
 * - status: 当前状态
 * - reason: 停止原因（breakpoint、step、exception、entry）
 * - line/file/frameId: 停止位置信息
 * - threadId: 触发停止的线程 ID
 * - allThreadsStopped: 是否所有线程都停止
 */
export interface DebugState {
    status: DebugStatus;
    reason?: string;  // 'breakpoint', 'step', 'exception', 'entry'
    line?: number;
    file?: string;
    frameId?: number;
    threadId?: number;
    allThreadsStopped?: boolean;
}

/**
 * 栈帧信息结构
 */
interface StackFrameInfo {
    id?: number;
    name?: string;
    source?: { path?: string; name?: string };
    line?: number;
    column?: number;
}

/**
 * 状态解析器类型 - 用于将状态变化通知给等待者
 */
type StateResolver = (value: DebugState) => void;

// =============================================================================
// 模块级变量（模块内存活）
// =============================================================================

/** 当前调试状态 */
let currentState: DebugState = { status: 'stopped' };

/** 等待状态变化的 Promise 解析器 */
let resolver: StateResolver | null = null;

/** 超时定时器 */
let timeoutTimer: NodeJS.Timeout | null = null;

/** 默认超时时间（毫秒） */
const DEFAULT_TIMEOUT = 30000;

// =============================================================================
// 核心函数
// =============================================================================

/**
 * 等待调试器达到期望状态
 *
 * 这是阻塞式等待函数，调用后会一直阻塞直到：
 * 1. 调试器达到 expectedStatus 状态
 * 2. 调试器进入 'terminated' 状态（立即返回）
 * 3. 超过 timeout 毫秒（返回 timeout 状态）
 *
 * @param expectedStatus - 期望的状态（通常是 'stopped'）
 * @param timeout - 超时时间（毫秒），默认 30000
 * @returns 返回最终状态对象
 *
 * @example
 * // 等待调试器停在断点
 * const state = await waitForState('stopped', 30000);
 * console.log(`停在 ${state.file}:${state.line}`);
 */
export async function waitForState(
    expectedStatus: DebugStatus,
    timeout: number = DEFAULT_TIMEOUT
): Promise<DebugState> {
    // 如果已经处于期望状态，立即返回
    if (currentState.status === expectedStatus) {
        return currentState;
    }

    // 创建 Promise 并设置解析器
    return new Promise<DebugState>((resolve) => {
        // 清除之前的 resolver
        resolver = null;

        // 设置新的 resolver
        // 当状态变化时，如果匹配期望状态或已终止，则 resolve Promise
        resolver = (newState: DebugState) => {
            if (newState.status === expectedStatus || newState.status === 'terminated') {
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = null;
                }
                resolve(newState);
                resolver = null;
            }
        };

        // 设置超时保护
        timeoutTimer = setTimeout(() => {
            if (resolver) {
                resolver = null;
                resolve({
                    ...currentState,
                    status: 'timeout',
                    reason: 'timeout'
                });
            }
        }, timeout);
    });
}

/**
 * 更新调试状态
 *
 * 由 DapTracker 调用，当 DAP 事件发生时更新状态
 * 如果有等待者（resolver），会立即触发其执行
 *
 * @param newState - 要更新的状态字段（部分更新，合并到当前状态）
 */
export function updateState(newState: Partial<DebugState>): void {
    console.log('[StateManager] updateState:', JSON.stringify(newState), 'was:', JSON.stringify(currentState));
    currentState = { ...currentState, ...newState };
    console.log('[StateManager] state now:', JSON.stringify(currentState));

    // 如果有等待中的 resolver，触发它
    if (resolver) {
        resolver(currentState);
    }
}

/**
 * 获取当前调试状态（非阻塞）
 *
 * @returns 当前状态副本
 */
export function getCurrentState(): DebugState {
    return currentState;
}

/**
 * 重置状态管理器
 *
 * 在调试会话结束时调用，清空所有等待者和缓存状态
 */
export function resetState(): void {
    if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
    }
    resolver = null;
    currentState = { status: 'stopped' };
}

/**
 * 获取当前停止位置的栈帧信息
 *
 * @param threadId - 可选，指定线程 ID，不提供则使用缓存的 threadId
 * @returns 栈帧信息（第一帧是当前执行位置）
 */
export async function getStackTrace(threadId?: number): Promise<StackFrameInfo | null> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
        return null;
    }

    try {
        let targetThreadId = threadId;

        // If no threadId provided, use current state threadId
        if (!targetThreadId) {
            targetThreadId = currentState.threadId;
        }

        // Fallback: find a stopped thread
        if (!targetThreadId) {
            const threads = await session.customRequest('threads');
            if (threads && threads.body && threads.body.threads) {
                console.log('[StateManager] threads response:', JSON.stringify(threads.body.threads));
                const stoppedThread = threads.body.threads.find(
                    (t: any) => t.state === 'stopped'
                );
                targetThreadId = stoppedThread?.id;
                // If still not found, use first thread
                if (!targetThreadId && threads.body.threads.length > 0) {
                    targetThreadId = threads.body.threads[0].id;
                }
            }
        }

        if (!targetThreadId) {
            console.error('getStackTrace: no threadId available');
            return null;
        }

        const framesResponse = await session.customRequest('stackTrace', {
            threadId: targetThreadId
        });
        // Response format: { stackFrames: [...] } (not body.stackFrames)
        const frames = framesResponse?.body?.stackFrames || framesResponse?.stackFrames;
        if (frames && frames.length > 0) {
            const topFrame = frames[0];
            return {
                id: topFrame.id,
                name: topFrame.name,
                source: topFrame.source,
                line: topFrame.line,
                column: topFrame.column
            };
        }
    } catch (error) {
        console.error('Failed to get stack trace:', error);
    }

    return null;
}

/**
 * 获取变量
 *
 * 向调试器发送 DAP 'scopes' 和 'variables' 请求，获取当前帧的变量信息
 *
 * @param scopeMap - 可选，作用域名称到变量名列表的映射
 *                   例如：{ "Locals": ["user_id"], "Globals": ["*"] }
 *                   - 如果某个作用域是 ["*"]，返回该作用域下所有变量
 *                   - 如果不提供，返回所有作用域的所有变量（不推荐，传输量大）
 * @param frameId - 可选，栈帧 ID。不提供则使用当前缓存的 frameId
 * @returns 对象，键是作用域名，值是该作用域下变量名到变量值的映射
 *
 * @example
 * // 获取指定变量
 * const vars = await getVariables({ Locals: ["user_id"], Globals: ["*"] }, 4);
 * // 返回：{ Locals: { user_id: "1" }, Globals: { app: "<Flask 'app'>", ... } }
 */
export async function getVariables(scopeMap?: Record<string, string[]>, frameId?: number): Promise<Record<string, Record<string, any>>> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
        console.error('[getVariables] No active debug session');
        return {};
    }

    try {
        // Use provided frameId, or cached frameId from current state, or query
        let id = frameId || currentState.frameId;
        console.log('[getVariables] Using frameId:', id, 'scopeMap:', JSON.stringify(scopeMap));
        if (!id) {
            const stackFrame = await getStackTrace();
            id = stackFrame?.id;
            console.log('[getVariables] Got frameId from stackTrace:', id);
        }
        if (!id) {
            console.error('[getVariables] No frameId available');
            return {};
        }

        // Request scopes to find the appropriate variable reference
        const scopesResponse = await session.customRequest('scopes', {
            frameId: id
        });
        console.log('[getVariables] scopes response:', JSON.stringify(scopesResponse));

        // Handle both response formats: { body: { scopes: [...] } } or { scopes: [...] }
        const scopesList = scopesResponse?.body?.scopes || scopesResponse?.scopes;
        if (!scopesList || !Array.isArray(scopesList)) {
            console.error('[getVariables] No scopes found in response');
            return {};
        }

        const result: Record<string, Record<string, any>> = {};

        // If no scopeMap provided, fetch all variables from all scopes
        if (!scopeMap) {
            for (const scopeInfo of scopesList) {
                const variables = await fetchVariablesForScope(session, scopeInfo);
                if (Object.keys(variables).length > 0) {
                    result[scopeInfo.name] = variables;
                }
            }
            return result;
        }

        // Process each scope in the scopeMap
        for (const [scopeName, varNames] of Object.entries(scopeMap)) {
            const scopeInfo = scopesList.find((s: any) => s.name === scopeName);
            if (!scopeInfo) {
                console.log('[getVariables] Scope not found:', scopeName);
                continue;
            }

            // If varNames is ["*"], fetch all variables in this scope
            if (varNames.length === 1 && varNames[0] === '*') {
                const variables = await fetchVariablesForScope(session, scopeInfo);
                if (Object.keys(variables).length > 0) {
                    result[scopeName] = variables;
                }
            } else {
                // Fetch specific variables
                const allVariables = await fetchVariablesForScope(session, scopeInfo);
                const filtered: Record<string, any> = {};
                for (const varName of varNames) {
                    if (varName in allVariables) {
                        filtered[varName] = allVariables[varName];
                    } else {
                        console.log('[getVariables] Variable not found:', varName, 'in scope:', scopeName);
                    }
                }
                if (Object.keys(filtered).length > 0) {
                    result[scopeName] = filtered;
                }
            }
        }

        return result;
    } catch (error) {
        console.error('[getVariables] Error:', error);
    }

    return {};
}

/**
 * 获取指定作用域的所有变量
 *
 * 内部函数，向调试器发送 'variables' 请求
 *
 * @param session - VSCode 调试会话
 * @param scopeInfo - 作用域信息（包含 variablesReference）
 * @returns 变量名到变量值的映射
 */
async function fetchVariablesForScope(session: vscode.DebugSession, scopeInfo: any): Promise<Record<string, any>> {
    const variablesResponse = await session.customRequest('variables', {
        variablesReference: scopeInfo.variablesReference
    });
    console.log('[getVariables] variables response for scope', scopeInfo.name, ':', JSON.stringify(variablesResponse));

    // Handle both formats: { body: { variables: [...] } } or { variables: [...] }
    const variablesList = variablesResponse?.body?.variables || variablesResponse?.variables;
    if (!variablesList || !Array.isArray(variablesList)) {
        console.error('[getVariables] No variables found for scope:', scopeInfo.name);
        return {};
    }

    const result: Record<string, any> = {};
    for (const v of variablesList) {
        result[v.name] = v.value;
    }
    return result;
}
