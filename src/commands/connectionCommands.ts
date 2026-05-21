import * as vscode from 'vscode';
import * as fs from 'fs';
import SSHConfig, { LineType } from 'ssh-config';
import { ConnectionManager } from '../core/connectionManager';
import { ConnectionProfile, ConnectionStatus, Protocol, AuthConfig } from '../core/protocol';
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

        logger.show();
        logger.info(`=== Connect requested: ${profile.name} (${profile.username}@${profile.host}:${profile.port}) ===`);
        logger.info(`Auth type: ${profile.auth.type}, privateKeyPath: ${profile.auth.privateKeyPath || 'not set'}, has passphrase: ${!!profile.auth.passphrase}`);

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

    vscode.commands.registerCommand('ssh.editConnection', async (item?) => {
      try {
        const profileId = item?.profile?.id;
        if (!profileId) {
          vscode.window.showErrorMessage('No connection selected');
          return;
        }

        const profile = connectionManager.getProfile(profileId);
        if (!profile) return;

        const panel = vscode.window.createWebviewPanel(
          'sshEditConnection',
          `编辑连接: ${profile.name}`,
          vscode.ViewColumn.One,
          { enableScripts: true, retainContextWhenHidden: true },
        );

        panel.webview.html = getEditConnectionHtml(profile);

        panel.webview.onDidReceiveMessage(async (msg) => {
          switch (msg.type) {
            case 'save': {
              const { name, host, port, username, authType, password, privateKeyPath, remotePath, protocol } = msg.data;

              if (!name || !host || !username) {
                vscode.window.showErrorMessage('名称、主机和用户名不能为空');
                return;
              }

              const auth: AuthConfig = authType === 'password'
                ? { type: 'password', password: password || undefined }
                : authType === 'agent'
                  ? { type: 'agent' }
                  : { type: 'privateKey', privateKeyPath: privateKeyPath || undefined };

              if (profile.source === 'config-file') {
                updateSshConfigFile(profile, { name, host, port, username, auth, remotePath });
              } else {
                await updateManualConnection(profileId, { name, host, port, username, auth, remotePath, protocol });
              }

              panel.dispose();
              connectionManager.reload();
              treeProvider.refresh();
              logger.info(`Edited connection: ${name} (${username}@${host}:${port})`);
              vscode.window.showInformationMessage(`连接 "${name}" 已更新`);
              break;
            }
            case 'cancel':
              panel.dispose();
              break;
          }
        });
      } catch (err) {
        vscode.window.showErrorMessage(`编辑连接失败: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.deleteConnection', async (item?) => {
      try {
        const profileId = item?.profile?.id;
        if (!profileId) {
          vscode.window.showErrorMessage('No connection selected');
          return;
        }

        const profile = connectionManager.getProfile(profileId);
        if (!profile) return;

        const confirm = await vscode.window.showWarningMessage(
          `确定要删除连接 "${profile.name}" 吗？此操作不可撤销。`,
          { modal: true },
          '删除',
        );
        if (confirm !== '删除') return;

        await connectionManager.disconnect(profileId);
        statusBar.updateConnectionStatus(profileId, profile.name, ConnectionStatus.Disconnected);

        if (profile.source === 'config-file') {
          deleteFromSshConfig(profile);
        } else {
          const connections = vscode.workspace.getConfiguration('ssh').get<Array<Record<string, unknown>>>('connections', []);
          const filtered = connections.filter((c: any) => c.id !== profileId);
          await vscode.workspace.getConfiguration('ssh').update(
            'connections',
            filtered,
            vscode.ConfigurationTarget.Global,
          );
        }

        treeProvider.refresh();
        vscode.window.showInformationMessage(`连接 "${profile.name}" 已删除`);
      } catch (err) {
        vscode.window.showErrorMessage(`删除连接失败: ${err}`);
      }
    }),
  );
}

function getEditConnectionHtml(profile: ConnectionProfile): string {
  const authType = profile.auth.type;
  const privateKeyPath = profile.auth.privateKeyPath || '';
  const hasPassword = !!profile.auth.password;
  const remotePath = profile.remotePath || '';
  const sourceLabel = profile.source === 'config-file' ? 'SSH 配置文件' : '手动配置';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>编辑连接</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { padding: 16px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h3 { margin-bottom: 16px; font-weight: 500; }
    .form-group { margin-bottom: 14px; }
    label { display: block; margin-bottom: 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    input, select { width: 100%; padding: 6px 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); border-radius: 2px; }
    input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
    .row { display: flex; gap: 12px; }
    .row > * { flex: 1; }
    .auth-section { display: none; margin-top: 8px; }
    .auth-section.visible { display: block; }
    .buttons { margin-top: 20px; display: flex; gap: 8px; justify-content: flex-end; }
    button { padding: 6px 16px; border: none; border-radius: 2px; cursor: pointer; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .btn-save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-save:hover { background: var(--vscode-button-hoverBackground); }
    .btn-cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-cancel:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .source-badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 8px; }
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  </style>
</head>
<body>
  <h3>编辑连接 <span class="source-badge">${sourceLabel}</span></h3>
  <form id="editForm">
    <div class="form-group">
      <label>连接名称 *</label>
      <input type="text" id="name" value="${escapeHtml(profile.name)}" required>
    </div>
    <div class="row">
      <div class="form-group">
        <label>服务器地址 *</label>
        <input type="text" id="host" value="${escapeHtml(profile.host)}" required>
      </div>
      <div class="form-group">
        <label>端口</label>
        <input type="number" id="port" value="${profile.port}">
      </div>
    </div>
    <div class="form-group">
      <label>用户名 *</label>
      <input type="text" id="username" value="${escapeHtml(profile.username)}" required>
    </div>
    <div class="form-group">
      <label>认证方式</label>
      <select id="authType">
        <option value="privateKey" ${authType === 'privateKey' ? 'selected' : ''}>SSH 密钥</option>
        <option value="password" ${authType === 'password' ? 'selected' : ''}>密码</option>
        <option value="agent" ${authType === 'agent' ? 'selected' : ''}>SSH Agent</option>
      </select>
    </div>
    <div class="auth-section ${authType === 'privateKey' ? 'visible' : ''}" id="keySection">
      <div class="form-group">
        <label>私钥路径</label>
        <input type="text" id="privateKeyPath" value="${escapeHtml(privateKeyPath)}" placeholder="~/.ssh/id_rsa">
        <div class="hint">留空使用默认密钥</div>
      </div>
    </div>
    <div class="auth-section ${authType === 'password' ? 'visible' : ''}" id="passwordSection">
      <div class="form-group">
        <label>密码</label>
        <input type="password" id="password" placeholder="${hasPassword ? '(已设置,留空保持不变)' : ''}">
        ${hasPassword ? '<div class="hint">留空则保持原密码不变</div>' : ''}
      </div>
    </div>
    <div class="form-group">
      <label>远程根路径</label>
      <input type="text" id="remotePath" value="${escapeHtml(remotePath)}" placeholder="/home/user">
    </div>
    <div class="form-group">
      <label>传输协议</label>
      <select id="protocol">
        <option value="sftp" ${profile.protocol === 'sftp' ? 'selected' : ''}>SFTP</option>
        <option value="scp" ${profile.protocol === 'scp' ? 'selected' : ''}>SCP</option>
      </select>
    </div>
    <div class="buttons">
      <button type="button" class="btn-cancel" id="btnCancel">取消</button>
      <button type="button" class="btn-save" id="btnSave">保存</button>
    </div>
  </form>
  <script>
    const vscode = acquireVsCodeApi();
    const authType = document.getElementById('authType');
    const keySection = document.getElementById('keySection');
    const passwordSection = document.getElementById('passwordSection');

    authType.addEventListener('change', () => {
      keySection.classList.toggle('visible', authType.value === 'privateKey');
      passwordSection.classList.toggle('visible', authType.value === 'password');
    });

    document.getElementById('btnSave').addEventListener('click', () => {
      vscode.postMessage({
        type: 'save',
        data: {
          name: document.getElementById('name').value.trim(),
          host: document.getElementById('host').value.trim(),
          port: parseInt(document.getElementById('port').value) || 22,
          username: document.getElementById('username').value.trim(),
          authType: authType.value,
          password: document.getElementById('password').value,
          privateKeyPath: document.getElementById('privateKeyPath').value.trim(),
          remotePath: document.getElementById('remotePath').value.trim(),
          protocol: document.getElementById('protocol').value,
        },
      });
    });

    document.getElementById('btnCancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function updateManualConnection(
  profileId: string,
  data: { name: string; host: string; port: number; username: string; auth: AuthConfig; remotePath: string; protocol: string },
): Promise<void> {
  const connections = vscode.workspace.getConfiguration('ssh').get<Array<Record<string, unknown>>>('connections', []);
  const index = connections.findIndex((c: any) => c.id === profileId);
  if (index !== -1) {
    connections[index] = {
      ...connections[index],
      name: data.name,
      host: data.host,
      port: data.port,
      username: data.username,
      protocol: data.protocol,
      auth: data.auth,
      remotePath: data.remotePath,
    };
  }
  await vscode.workspace.getConfiguration('ssh').update('connections', connections, vscode.ConfigurationTarget.Global);
}

function updateSshConfigFile(
  profile: ConnectionProfile,
  data: { name: string; host: string; port: number; username: string; auth: AuthConfig; remotePath: string },
): void {
  const configPath = profile.configFilePath;
  if (!configPath || !fs.existsSync(configPath)) {
    throw new Error('SSH 配置文件不存在');
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const config = SSHConfig.parse(content);

  for (const line of config) {
    if (line.type === LineType.DIRECTIVE && line.param === 'Host' && line.value === profile.name) {
      applyDirective(line, 'HostName', data.host);
      applyDirective(line, 'Port', data.port === 22 ? undefined : String(data.port));
      applyDirective(line, 'User', data.username);

      removeDirective(line, 'IdentityFile');
      removeDirective(line, 'IdentityAgent');

      if (data.auth.type === 'privateKey' && data.auth.privateKeyPath) {
        addDirective(line, 'IdentityFile', data.auth.privateKeyPath);
      } else if (data.auth.type === 'agent') {
        addDirective(line, 'IdentityAgent', data.auth.agent || process.env.SSH_AUTH_SOCK || '');
      }

      if (data.remotePath) {
        applyDirective(line, 'RemotePath', data.remotePath);
      } else {
        removeDirective(line, 'RemotePath');
      }

      if (data.name !== profile.name) {
        line.value = data.name;
      }

      break;
    }
  }

  fs.writeFileSync(configPath, SSHConfig.stringify(config), 'utf-8');
}

function applyDirective(hostLine: any, param: string, value: string | undefined): void {
  if (!hostLine.config) hostLine.config = [];
  const existing = hostLine.config.find((c: any) => c.param === param);
  if (existing) {
    if (value !== undefined) {
      existing.value = value;
    } else {
      const idx = hostLine.config.indexOf(existing);
      hostLine.config.splice(idx, 1);
    }
  } else if (value !== undefined) {
    const lastChild = hostLine.config[hostLine.config.length - 1];
    const newDirective: any = {
      type: LineType.DIRECTIVE,
      param,
      separator: ' ',
      value,
      before: '  ',
      after: '',
    };
    if (lastChild) lastChild.after = '\n';
    hostLine.config.push(newDirective);
  }
}

function removeDirective(hostLine: any, param: string): void {
  if (!hostLine.config) return;
  const idx = hostLine.config.findIndex((c: any) => c.param === param);
  if (idx !== -1) hostLine.config.splice(idx, 1);
}

function addDirective(hostLine: any, param: string, value: string): void {
  if (!hostLine.config) hostLine.config = [];
  const lastChild = hostLine.config[hostLine.config.length - 1];
  const newDirective: any = {
    type: LineType.DIRECTIVE,
    param,
    separator: ' ',
    value,
    before: '  ',
    after: '',
  };
  if (lastChild) lastChild.after = '\n';
  hostLine.config.push(newDirective);
}

function deleteFromSshConfig(profile: ConnectionProfile): void {
  const configPath = profile.configFilePath;
  if (!configPath || !fs.existsSync(configPath)) {
    throw new Error('SSH 配置文件不存在');
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const config = SSHConfig.parse(content);

  const idx = config.findIndex(
    (line: any) => line.type === LineType.DIRECTIVE && line.param === 'Host' && line.value === profile.name,
  );

  if (idx !== -1) {
    config.splice(idx, 1);
    fs.writeFileSync(configPath, SSHConfig.stringify(config), 'utf-8');
  }
}
