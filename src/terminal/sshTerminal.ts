import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { ConnectionStatus } from '../core/protocol';
import { buildSshArgs, toCliArgs } from '../core/openSshArgs';
import { profileHasCertificate } from '../core/backendSelector';
import { Logger } from '../utils/logger';
import { createPasswordAskpass, PasswordAskpass } from './passwordAskpass';
import * as fs from 'fs';

export function registerTerminalCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  logger: Logger,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('ssh.openTerminal', async (item?) => {
      let askpass: PasswordAskpass | undefined;
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

        if (profile.auth.type === 'password' && profile.auth.password) {
          askpass = createPasswordAskpass(profile.auth.password);
        }

        const certPath = profileHasCertificate(profile, fs.existsSync) || undefined;
        const sshArgs = buildSshArgs(profile, { certificateFile: certPath });
        const args = ['-t', ...toCliArgs(sshArgs)];

        const terminal = vscode.window.createTerminal({
          name: `SSH: ${profile.name}`,
          shellPath: 'ssh',
          shellArgs: args,
          env: askpass?.env,
        });

        if (askpass) {
          const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
            if (closedTerminal === terminal) {
              askpass?.cleanup();
              disposable.dispose();
            }
          });
          context.subscriptions.push(disposable);
        }

        terminal.show();
        logger.info(`Opened SSH terminal for ${profile.name}`);
      } catch (err) {
        askpass?.cleanup();
        vscode.window.showErrorMessage(`Failed to open terminal: ${err}`);
      }
    }),
  );
}
