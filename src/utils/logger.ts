import * as vscode from 'vscode';

export class Logger {
  private readonly outputChannel: vscode.OutputChannel;

  constructor(name: string) {
    this.outputChannel = vscode.window.createOutputChannel(name);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('INFO', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('WARN', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('ERROR', message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('DEBUG', message, args);
  }

  private log(level: string, message: string, args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const argsStr = args.length > 0 ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
    this.outputChannel.appendLine(`[${timestamp}] [${level}] ${message}${argsStr}`);
  }

  show(): void {
    this.outputChannel.show(true);
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}
