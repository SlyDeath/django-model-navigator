/**
 * Write diagnostics to the Django Model Navigator output channel
 * Debug messages are optional; errors are always logged
 */

import * as vscode from 'vscode';

class Logger {
    private channel: vscode.OutputChannel | null = null;
    private debugEnabled = false;

    setDebug(enabled: boolean): void {
        if (this.debugEnabled === enabled) return;

        this.debugEnabled = enabled;

        // Log the toggle itself even when debug logging is being disabled
        this.write(enabled ? '🐞 Debug logging enabled' : '🐞 Debug logging disabled');
    }

    get isDebugEnabled(): boolean {
        return this.debugEnabled;
    }

    debug(message: string): void {
        if (!this.debugEnabled) return;

        this.write(message);
    }

    error(message: string, error?: unknown): void {
        const details = error instanceof Error ? error.stack ?? error.message : error;

        this.write(details ? `${message} ${details}` : message);
    }

    show(): void {
        this.ensureChannel().show(true);
    }

    dispose(): void {
        this.channel?.dispose();
        this.channel = null;
    }

    private ensureChannel(): vscode.OutputChannel {
        if (!this.channel) {
            this.channel = vscode.window.createOutputChannel('Django Model Navigator');
        }

        return this.channel;
    }

    private write(message: string): void {
        const time = new Date().toISOString().slice(11, 23);

        this.ensureChannel().appendLine(`[${time}] ${message}`);
    }
}

export const logger = new Logger();
