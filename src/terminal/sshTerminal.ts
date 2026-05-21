import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { ConnectionStatus } from '../core/protocol';
import { Logger } from '../utils/logger';

class SshPseudoterminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number>();
  private channel: any = null;

  onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  onDidClose: vscode.Event<number> = this.closeEmitter.event;

  constructor(
    private readonly profileId: string,
    private readonly connectionManager: ConnectionManager,
    private readonly logger: Logger,
  ) {}

  async open(_initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
    try {
      const conn = this.connectionManager.getConnection(this.profileId);
      if (!conn || conn.status !== ConnectionStatus.Connected) {
        this.writeEmitter.fire('\x1b[31mNot connected. Connecting...\x1b[0m\r\n');
        await this.connectionManager.connect(this.profileId);
      }

      const connected = this.connectionManager.getConnection(this.profileId);
      if (!connected) {
        this.writeEmitter.fire('\x1b[31mFailed to connect.\x1b[0m\r\n');
        this.closeEmitter.fire(1);
        return;
      }

      this.channel = await connected.createShellStream();

      this.channel.on('data', (data: Buffer) => {
        this.writeEmitter.fire(data.toString('utf-8'));
      });

      this.channel.on('close', () => {
        this.writeEmitter.fire('\r\n\x1b[33mShell connection closed.\x1b[0m\r\n');
        this.closeEmitter.fire(0);
      });

      this.channel.on('error', (err: Error) => {
        this.logger.error(`Shell stream error: ${err.message}`);
        this.writeEmitter.fire(`\r\n\x1b[31mError: ${err.message}\x1b[0m\r\n`);
        this.closeEmitter.fire(1);
      });

      this.writeEmitter.fire('\x1b[32mConnected!\x1b[0m\r\n');
    } catch (err) {
      this.logger.error(`Failed to open PTY terminal: ${err}`);
      this.writeEmitter.fire(`\r\n\x1b[31mFailed to open shell: ${err}\x1b[0m\r\n`);
      this.closeEmitter.fire(1);
    }
  }

  close(): void {
    if (this.channel) {
      try { this.channel.close(); } catch {}
    }
  }

  handleInput(data: string): void {
    if (this.channel) {
      this.channel.write(data);
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.channel && this.channel.setWindow) {
      try {
        this.channel.setWindow(dimensions.rows, dimensions.columns, 0, 0);
      } catch {}
    }
  }
}

export function registerTerminalCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  logger: Logger,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('ssh.openTerminal', async (item?) => {
      try {
        const profileId = item?.profile?.id;
        if (!profileId) {
          vscode.window.showErrorMessage('No connection selected');
          return;
        }

        const profile = connectionManager.getProfile(profileId);
        if (!profile) return;

        const pty = new SshPseudoterminal(profileId, connectionManager, logger);
        const terminal = vscode.window.createTerminal({
          name: `SSH: ${profile.name}`,
          pty,
        });

        terminal.show();
        logger.info(`Opened SSH PTY terminal for ${profile.name}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to open terminal: ${err}`);
      }
    }),
  );
}
