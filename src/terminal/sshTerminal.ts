import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { ConnectionStatus } from '../core/protocol';
import { Logger } from '../utils/logger';

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

        const conn = connectionManager.getConnection(profileId);
        if (!conn || conn.status !== ConnectionStatus.Connected) {
          vscode.window.showInformationMessage(`Connecting to ${profile.name}...`);
          await connectionManager.connect(profileId);
        }

        const terminal = vscode.window.createTerminal({
          name: `SSH: ${profile.name}`,
          shellPath: 'ssh',
          shellArgs: ['-t', `${profile.username}@${profile.host}`, '-p', String(profile.port)],
        });

        terminal.show();
        logger.info(`Opened SSH terminal for ${profile.name}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to open terminal: ${err}`);
      }
    }),
  );
}
