import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { ConnectionStatus, Protocol, AuthConfig } from '../core/protocol';
import { RemoteExplorerTreeProvider } from '../providers/remoteExplorer';
import { StatusBarManager } from '../statusbar/statusBarManager';
import { Logger } from '../utils/logger';

export function registerConnectionCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  treeProvider: RemoteExplorerTreeProvider,
  statusBar: StatusBarManager,
  logger: Logger,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('ssh.connect', async (item?) => {
      try {
        let profileId: string;

        if (item?.profile?.id) {
          profileId = item.profile.id;
        } else {
          const profiles = connectionManager.getAllProfiles();
          if (profiles.length === 0) {
            vscode.window.showWarningMessage('No SSH connections configured. Add connections via settings or ~/.ssh/config');
            return;
          }
          const selected = await vscode.window.showQuickPick(
            profiles.map(p => ({
              label: p.name,
              description: `${p.username}@${p.host}:${p.port}`,
              profileId: p.id,
            })),
            { placeHolder: 'Select a connection' },
          );
          if (!selected) return;
          profileId = selected.profileId;
        }

        const profile = connectionManager.getProfile(profileId);
        if (!profile) return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${profile.name}...`,
            cancellable: false,
          },
          async () => {
            await connectionManager.connect(profileId);
          },
        );

        statusBar.updateConnectionStatus(profileId, profile.name, ConnectionStatus.Connected);
        treeProvider.refresh();
        logger.info(`Connected to ${profile.name}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to connect: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.disconnect', async (item?) => {
      try {
        const profileId = item?.profile?.id;
        if (!profileId) {
          vscode.window.showErrorMessage('No connection selected');
          return;
        }

        const profile = connectionManager.getProfile(profileId);
        await connectionManager.disconnect(profileId);

        if (profile) {
          statusBar.updateConnectionStatus(profileId, profile.name, ConnectionStatus.Disconnected);
        }
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to disconnect: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.addConnection', async () => {
      try {
        const name = await vscode.window.showInputBox({
          prompt: 'Connection name',
          placeHolder: 'my-server',
        });
        if (!name) return;

        const host = await vscode.window.showInputBox({
          prompt: 'Server host or IP',
          placeHolder: '192.168.1.100',
        });
        if (!host) return;

        const portStr = await vscode.window.showInputBox({
          prompt: 'SSH port',
          placeHolder: '22',
          value: '22',
        });
        const port = parseInt(portStr || '22', 10);

        const username = await vscode.window.showInputBox({
          prompt: 'Username',
          placeHolder: 'root',
        });
        if (!username) return;

        const authChoice = await vscode.window.showQuickPick(
          ['SSH Key (default)', 'Password', 'SSH Agent'],
          { placeHolder: 'Authentication method' },
        );

        let auth: AuthConfig;
        if (authChoice === 'Password') {
          const password = await vscode.window.showInputBox({
            prompt: 'Password',
            password: true,
          });
          auth = { type: 'password', password };
        } else if (authChoice === 'SSH Agent') {
          auth = { type: 'agent' };
        } else {
          const keyPath = await vscode.window.showInputBox({
            prompt: 'Private key path (leave empty for default)',
            placeHolder: '~/.ssh/id_rsa',
          });
          auth = {
            type: 'privateKey',
            privateKeyPath: keyPath || undefined,
          };
        }

        const remotePath = await vscode.window.showInputBox({
          prompt: 'Remote root path (optional)',
          placeHolder: '/home/user',
        });

        const protocol = await vscode.window.showQuickPick(
          ['sftp', 'scp'],
          { placeHolder: 'Transfer protocol' },
        ) as Protocol;

        const connections = vscode.workspace.getConfiguration('ssh').get<Array<Record<string, unknown>>>('connections', []);
        connections.push({
          id: `manual-${name}`,
          name,
          host,
          port,
          username,
          protocol: protocol || Protocol.SFTP,
          auth,
          remotePath: remotePath || '',
        });

        await vscode.workspace.getConfiguration('ssh').update(
          'connections',
          connections,
          vscode.ConfigurationTarget.Global,
        );

        logger.info(`Added connection: ${name} (${username}@${host}:${port})`);
        vscode.window.showInformationMessage(`Connection "${name}" added`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to add connection: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.refresh', () => {
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('ssh.refreshDirectory', (item) => {
      treeProvider.refresh(item);
    }),
  );
}
