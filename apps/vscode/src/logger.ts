import * as vscode from 'vscode';

/**
 * The AI Config output channel.
 *
 * Routine detail belongs here rather than in notifications: a synchronization
 * tool that pops a toast on every save quickly becomes something users disable.
 */
export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('AI Config');

  public info(message: string): void {
    this.channel.appendLine(`[${timestamp()}] ${message}`);
  }

  public error(message: string, error?: unknown): void {
    this.info(`ERROR ${message}`);
    if (error !== undefined) {
      // Stack traces belong in the log, never in a notification.
      this.channel.appendLine(describe(error));
    }
  }

  public show(): void {
    this.channel.show(true);
  }

  public dispose(): void {
    this.channel.dispose();
  }
}

const timestamp = (): string => new Date().toISOString().slice(11, 19);

const describe = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
};
