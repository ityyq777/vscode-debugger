import * as vscode from 'vscode';
import { registerDapTracker } from './DapTracker';
import { startHttpServer, startServer, stopServer, isServerRunning, getServerPort } from './server';
import { resetState } from './StateManager';

let statusBarItem: vscode.StatusBarItem;

function updateStatusBar(): void {
    if (isServerRunning()) {
        statusBarItem.text = `vdp √ (${getServerPort()})`;
        statusBarItem.tooltip = `VSCode Debugger Proxy running on port ${getServerPort()}. Click to stop.`;
    } else {
        statusBarItem.text = 'vdp ×';
        statusBarItem.tooltip = 'VSCode Debugger Proxy stopped. Click to start.';
    }
}

async function toggleServer(): Promise<void> {
    if (isServerRunning()) {
        stopServer();
    } else {
        try {
            await startServer();
        } catch (error) {
            // Error already shown in startServer
            return;
        }
    }
    updateStatusBar();
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('[Extension] VSCode Debugger Proxy activating...');

    // Register the DAP tracker to intercept debug events
    registerDapTracker(context);

    // Set up HTTP server routes (but don't start yet)
    startHttpServer(context);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100  // priority
    );
    statusBarItem.command = 'vscode-debugger-proxy.toggle';
    context.subscriptions.push(statusBarItem);
    updateStatusBar();
    statusBarItem.show();

    // Register toggle command
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-debugger-proxy.toggle', toggleServer)
    );

    // Reset state on activation
    resetState();

    // Auto-start if configured
    const config = vscode.workspace.getConfiguration('debuggerProxy');
    const autoStart = config.get<boolean>('autoStart', false);
    if (autoStart) {
        try {
            await startServer();
        } catch (error) {
            // Error already shown in startServer
        }
        updateStatusBar();
    }

    console.log('[Extension] VSCode Debugger Proxy activated successfully');
}

export function deactivate() {
    console.log('[Extension] VSCode Debugger Proxy deactivated');
    stopServer();
    resetState();
}
