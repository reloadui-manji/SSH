import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { ConnectionStatus, Protocol, AuthConfig, ConnectionProfile } from '../core/protocol';
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
            vscode.window.showWarningMessage('No SSH connections configured. Add connections in VS Code settings.');
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

    vscode.commands.registerCommand('ssh.editConnection', async (item?) => {
      try {
        const profileId = item?.profile?.id;
        if (!profileId) {
          vscode.window.showErrorMessage('No connection selected');
          return;
        }

        const profile = connectionManager.getProfile(profileId);
        if (!profile) return;

        openConnectionEditor(connectionManager, treeProvider, statusBar, logger, profile);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to open editor: ${err}`);
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
          `确定要删除连接 "${profile.name}" 吗？`,
          { modal: true },
          '删除',
        );
        if (confirm !== '删除') return;

        // Disconnect first if connected
        const conn = connectionManager.getConnection(profileId);
        if (conn && conn.status === ConnectionStatus.Connected) {
          await connectionManager.disconnect(profileId);
        }

        // Remove from settings
        const connections = vscode.workspace.getConfiguration('ssh').get<Array<Record<string, unknown>>>('connections', []);
        const updated = connections.filter((c: Record<string, unknown>) => c.id !== profileId && c.name !== profile.name);

        await vscode.workspace.getConfiguration('ssh').update(
          'connections',
          updated,
          vscode.ConfigurationTarget.Global,
        );

        statusBar.updateConnectionStatus(profileId, profile.name, ConnectionStatus.Disconnected);
        treeProvider.refresh();
        logger.info(`Deleted connection: ${profile.name}`);
        vscode.window.showInformationMessage(`已删除连接 "${profile.name}"`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete connection: ${err}`);
      }
    }),
  );
}

interface ConnectionEditorData {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: string;
  privateKeyPath: string;
  password: string;
  agent: string;
  remotePath: string;
  protocol: string;
  backend: string;
  certificatePath: string;
  passphrase: string;
}

function openConnectionEditor(
  connectionManager: ConnectionManager,
  treeProvider: RemoteExplorerTreeProvider,
  _statusBar: StatusBarManager,
  logger: Logger,
  profile: ConnectionProfile,
): void {
  const data: ConnectionEditorData = {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authType: profile.auth.type,
    privateKeyPath: profile.auth.privateKeyPath || '',
    password: profile.auth.password || '',
    agent: profile.auth.agent || '',
    remotePath: profile.remotePath || '',
    protocol: profile.protocol || Protocol.SFTP,
    backend: profile.backend || 'auto',
    certificatePath: profile.auth.certificatePath || '',
    passphrase: profile.auth.passphrase || '',
  };

  const panel = vscode.window.createWebviewPanel(
    'sshConnectionEditor',
    `编辑连接 — ${profile.name}`,
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  panel.webview.html = buildConnectionEditorHtml(data);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'save') {
      try {
        const saved = msg.data as ConnectionEditorData;
        if (!saved.name || !saved.host || !saved.username) {
          vscode.window.showErrorMessage('连接名称、服务器地址和用户名为必填项');
          return;
        }

        let auth: AuthConfig;
        switch (saved.authType) {
          case 'password':
            auth = {
              type: 'password',
              password: saved.password || profile.auth.password,
            };
            break;
          case 'agent':
            auth = {
              type: 'agent',
              agent: saved.agent || undefined,
            };
            break;
          case 'keyboard-interactive':
            auth = { type: 'keyboard-interactive' };
            break;
          default:
            auth = {
              type: 'privateKey',
              privateKeyPath: saved.privateKeyPath || undefined,
              certificatePath: saved.certificatePath || undefined,
              passphrase: saved.passphrase || undefined,
            };
            break;
        }

        const connections = vscode.workspace.getConfiguration('ssh').get<Array<Record<string, unknown>>>('connections', []);
        const idx = connections.findIndex((c: Record<string, unknown>) => c.id === saved.id || c.name === profile.name);

        const profileEntry: Record<string, unknown> = {
          id: saved.id,
          name: saved.name,
          host: saved.host,
          port: saved.port,
          username: saved.username,
          protocol: saved.protocol,
          backend: saved.backend,
          auth,
          remotePath: saved.remotePath,
        };

        if (idx >= 0) {
          connections[idx] = profileEntry;
        } else {
          connections.push(profileEntry);
        }

        await vscode.workspace.getConfiguration('ssh').update(
          'connections',
          connections,
          vscode.ConfigurationTarget.Global,
        );

        connectionManager.reload();
        treeProvider.refresh();
        logger.info(`Updated connection: ${saved.name}`);
        vscode.window.showInformationMessage(`已更新连接 "${saved.name}"`);
        panel.dispose();
      } catch (err) {
        vscode.window.showErrorMessage(`保存失败: ${err}`);
      }
    } else if (msg.type === 'cancel') {
      panel.dispose();
    }
  });
}

const AUTH_TYPE_LABELS: Record<string, string> = {
  password: '密码',
  privateKey: 'SSH 密钥',
  agent: 'SSH Agent',
  'keyboard-interactive': '键盘交互',
};

function buildConnectionEditorHtml(data: ConnectionEditorData): string {
  const authOptions = Object.entries(AUTH_TYPE_LABELS).map(([value, label]) =>
    `<option value="${value}" ${value === data.authType ? 'selected' : ''}>${label}</option>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #cccccc);
    --border: var(--vscode-panel-border, #444);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground, #cccccc);
    --button-bg: var(--vscode-button-background, #0e639c);
    --button-fg: var(--vscode-button-foreground, #ffffff);
    --button-hover: var(--vscode-button-hoverBackground, #1177bb);
    --secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --secondary-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
    --desc: var(--vscode-descriptionForeground, #888);
  }
  body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family, sans-serif); padding: 20px; margin: 0; }
  h2 { font-size: 16px; margin: 0 0 16px; font-weight: 600; }
  .form-group { margin-bottom: 12px; }
  label { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 500; }
  label .required { color: #f48771; }
  input, select { width: 100%; padding: 6px 8px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); border-radius: 4px; font-size: 13px; box-sizing: border-box; }
  input:focus, select:focus { outline: 1px solid var(--button-bg); border-color: var(--button-bg); }
  .auth-section { padding: 8px 0; }
  .auth-fields { display: none; }
  .auth-fields.active { display: block; }
  .button-row { display: flex; gap: 8px; margin-top: 16px; }
  .btn { padding: 8px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; color: var(--button-fg); background: var(--button-bg); }
  .btn:hover { background: var(--button-hover); }
  .btn-secondary { background: var(--secondary-bg); color: var(--vscode-button-secondaryForeground, #cccccc); }
  .btn-secondary:hover { background: var(--secondary-hover); }
  .hint { color: var(--desc); font-size: 12px; margin-top: 2px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; background: var(--button-bg); color: var(--button-fg); font-size: 11px; }
  .hidden { display: none; }
</style>
</head>
<body>
  <h2>编辑连接 <span class="badge">手动配置</span></h2>
  <div class="form-group">
    <label>连接名称 <span class="required">*</span></label>
    <input type="text" id="name" value="${data.name}" required>
  </div>
  <div class="form-group">
    <label>服务器地址 <span class="required">*</span></label>
    <input type="text" id="host" value="${data.host}" required>
  </div>
  <div class="form-group">
    <label>端口</label>
    <input type="number" id="port" value="${data.port}" min="1" max="65535">
  </div>
  <div class="form-group">
    <label>用户名 <span class="required">*</span></label>
    <input type="text" id="username" value="${data.username}" required>
  </div>
  <div class="form-group auth-section">
    <label>认证方式</label>
    <select id="authType">
      ${authOptions}
    </select>
  </div>

  <div class="auth-fields" id="fields-privateKey">
    <div class="form-group">
      <label>私钥路径</label>
      <input type="text" id="privateKeyPath" value="${data.privateKeyPath}" placeholder="~/.ssh/id_rsa">
    </div>
    <div class="form-group" id="certField">
      <label>证书文件路径（可选）</label>
      <input type="text" id="certificatePath" value="${data.certificatePath}" placeholder="~/.ssh/id_rsa-cert.pub">
      <div class="hint">SSH 证书认证（CA-based），仅 openssh 后端支持</div>
    </div>
    <div class="form-group">
      <label>私钥密码短语</label>
      <input type="password" id="passphrase" value="${data.passphrase}" placeholder="已设置则留空保持原密码">
    </div>
  </div>

  <div class="auth-fields" id="fields-password">
    <div class="form-group">
      <label>密码</label>
      <input type="password" id="password" value="${data.password}" placeholder="留空保持原密码">
    </div>
  </div>

  <div class="auth-fields" id="fields-agent">
    <div class="form-group">
      <label>Agent Socket 路径（可选）</label>
      <input type="text" id="agent" value="${data.agent}" placeholder="$SSH_AUTH_SOCK">
    </div>
  </div>

  <div class="form-group">
    <label>远程根路径</label>
    <input type="text" id="remotePath" value="${data.remotePath}" placeholder="/home/user">
  </div>
  <div class="form-group">
    <label>传输协议</label>
    <select id="protocol">
      <option value="sftp" ${data.protocol === 'sftp' ? 'selected' : ''}>SFTP</option>
      <option value="scp" ${data.protocol === 'scp' ? 'selected' : ''}>SCP</option>
    </select>
  </div>
  <div class="form-group">
    <label>连接后端</label>
    <select id="backend">
      <option value="auto" ${data.backend === 'auto' ? 'selected' : ''}>自动（默认）</option>
      <option value="ssh2" ${data.backend === 'ssh2' ? 'selected' : ''}>ssh2（纯 Node.js）</option>
      <option value="openssh" ${data.backend === 'openssh' ? 'selected' : ''}>openssh（系统 ssh/scp）</option>
    </select>
    <div class="hint">ssh2：内置 SSH 库；openssh：使用系统 ssh/scp 命令，支持证书认证</div>
  </div>

  <div class="button-row">
    <button class="btn" id="save">保存</button>
    <button class="btn btn-secondary" id="cancel">取消</button>
  </div>

<script>
  var vscode = acquireVsCodeApi();
  var authType = document.getElementById('authType');
  var backendSelect = document.getElementById('backend');
  var certField = document.getElementById('certField');
  var certificatePathInput = document.getElementById('certificatePath');
  var fields = document.querySelectorAll('.auth-fields');

  function showAuthFields() {
    var val = authType.value;
    fields.forEach(function(f) { f.classList.remove('active'); });
    var target = document.getElementById('fields-' + val);
    if (target) target.classList.add('active');
  }

  function updateCertFieldVisibility() {
    if (!certField) return;
    var backend = backendSelect.value;
    if (backend === 'ssh2') {
      certField.classList.add('hidden');
      certificatePathInput.value = '';
    } else {
      certField.classList.remove('hidden');
    }
  }

  authType.addEventListener('change', showAuthFields);
  backendSelect.addEventListener('change', updateCertFieldVisibility);
  showAuthFields();
  updateCertFieldVisibility();

  document.getElementById('save').addEventListener('click', function() {
    var data = {
      id: ${JSON.stringify(data.id)},
      name: document.getElementById('name').value,
      host: document.getElementById('host').value,
      port: parseInt(document.getElementById('port').value) || 22,
      username: document.getElementById('username').value,
      authType: authType.value,
      privateKeyPath: document.getElementById('privateKeyPath').value,
      password: document.getElementById('password').value,
      agent: document.getElementById('agent').value,
      remotePath: document.getElementById('remotePath').value,
      protocol: document.getElementById('protocol').value,
      backend: document.getElementById('backend').value,
      certificatePath: document.getElementById('backend').value === 'ssh2' ? '' : document.getElementById('certificatePath').value,
      passphrase: document.getElementById('passphrase').value
    };
    vscode.postMessage({ type: 'save', data: data });
  });

  document.getElementById('cancel').addEventListener('click', function() {
    vscode.postMessage({ type: 'cancel' });
  });
</script>
</body>
</html>`;
}
