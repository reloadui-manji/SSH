import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { SyncEngine } from '../sync/syncEngine';
import { Logger } from '../utils/logger';

export function registerSyncCommands(
  context: vscode.ExtensionContext,
  _connectionManager: ConnectionManager,
  syncEngine: SyncEngine,
  _logger: Logger,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('ssh.toggleAutoUpload', async () => {
      const config = vscode.workspace.getConfiguration('ssh');
      const current = config.get<boolean>('autoUpload', false);
      await config.update('autoUpload', !current, vscode.ConfigurationTarget.Global);
      if (!current) {
        syncEngine.startAutoUpload();
      } else {
        syncEngine.stopAutoUpload();
      }
      vscode.window.showInformationMessage(`Auto upload on save: ${!current ? 'Enabled' : 'Disabled'}`);
    }),

    vscode.commands.registerCommand('ssh.syncUp', async () => {
      vscode.window.showInformationMessage('Sync up: syncing local workspace to remote server');
    }),

    vscode.commands.registerCommand('ssh.syncDown', async () => {
      vscode.window.showInformationMessage('Sync down: syncing remote server to local workspace');
    }),

    vscode.commands.registerCommand('ssh.syncDiff', async () => {
      vscode.window.showInformationMessage('Sync diff: comparing local and remote files');
    }),
  );
}
