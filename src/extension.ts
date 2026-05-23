import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { ConnectionManager } from './core/connectionManager';
import { ConnectionStatus } from './core/protocol';
import { RemoteExplorerTreeProvider } from './providers/remoteExplorer';
import { RemoteFileSystemProvider } from './providers/remoteFileSystem';
import { StatusBarManager } from './statusbar/statusBarManager';
import { registerConnectionCommands } from './commands/connectionCommands';
import { registerFileCommands } from './commands/fileCommands';
import { registerSyncCommands } from './commands/syncCommands';
import { registerTerminalCommands } from './terminal/sshTerminal';
import { SyncEngine } from './sync/syncEngine';

let statusBar: StatusBarManager | undefined;
let connectionManager: ConnectionManager | undefined;
let syncEngine: SyncEngine | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger('SSH/SFTP');
  context.subscriptions.push(logger);

  logger.info('SSH/SFTP extension activated');

  // Initialize connection manager
  connectionManager = new ConnectionManager(logger);
  await connectionManager.initialize();
  context.subscriptions.push(connectionManager);

  // Create status bar
  statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // Register tree provider
  const treeProvider = new RemoteExplorerTreeProvider(connectionManager, logger);
  const treeView = vscode.window.createTreeView('sshExplorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Register file system provider
  const fsProvider = new RemoteFileSystemProvider(connectionManager, logger);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('ssh', fsProvider, {
      isCaseSensitive: true,
    }),
  );

  // Initialize sync engine
  syncEngine = new SyncEngine(connectionManager, logger);
  context.subscriptions.push(syncEngine);

  // Register commands
  registerConnectionCommands(context, connectionManager, treeProvider, statusBar, logger);
  registerFileCommands(context, connectionManager, syncEngine, treeProvider, logger);
  registerSyncCommands(context, connectionManager, syncEngine, logger);
  registerTerminalCommands(context, connectionManager, logger);

  // Listen for connection status changes
  connectionManager.onConnectionStatusChanged.event(({ id, status }) => {
    const profile = connectionManager!.getProfile(id);
    if (profile && statusBar) {
      statusBar.updateConnectionStatus(id, profile.name, status);
    }

    // Set default connection for auto-upload when connected
    if (status === ConnectionStatus.Connected && profile) {
      syncEngine?.setDefaultConnection(id, profile.remotePath);
      logger.info(`Set default connection for sync: ${profile.name}`);
    }
  });

  // Handle auto-upload setting changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ssh.autoUpload')) {
        const enabled = vscode.workspace.getConfiguration('ssh').get<boolean>('autoUpload', false);
        if (enabled) {
          syncEngine?.startAutoUpload();
          logger.info('Auto-upload enabled');
        } else {
          syncEngine?.stopAutoUpload();
          logger.info('Auto-upload disabled');
        }
      }
    }),
  );

  // Start auto-upload if already enabled
  if (vscode.workspace.getConfiguration('ssh').get<boolean>('autoUpload', false)) {
    syncEngine.startAutoUpload();
  }

  // Handle showStatusBar setting
  const showStatusBar = vscode.workspace.getConfiguration('ssh').get<boolean>('showStatusBar', true);
  if (statusBar) {
    if (showStatusBar) {
      statusBar.show();
    } else {
      statusBar.hide();
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ssh.showStatusBar')) {
        const show = vscode.workspace.getConfiguration('ssh').get<boolean>('showStatusBar', true);
        if (statusBar) {
          if (show) {
            statusBar.show();
          } else {
            statusBar.hide();
          }
        }
      }
    }),
  );
}

export function deactivate(): void {
  connectionManager?.disconnectAll();
  connectionManager?.dispose();
  statusBar?.dispose();
  syncEngine?.dispose();
}
