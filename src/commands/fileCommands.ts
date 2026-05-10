import * as vscode from 'vscode';
import * as fs from 'fs';
import { ConnectionManager } from '../core/connectionManager';
import { SshConnection } from '../core/connection';
import { ConnectionStatus } from '../core/protocol';
import { RemoteFileItem, RemoteDirectoryItem } from '../providers/treeItems';
import { SyncEngine } from '../sync/syncEngine';
import { Logger } from '../utils/logger';
import * as pathUtils from '../utils/path';
import { t } from '../utils/i18n';

import { RemoteExplorerTreeProvider } from '../providers/remoteExplorer';

export function registerFileCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  syncEngine: SyncEngine,
  treeProvider: RemoteExplorerTreeProvider,
  logger: Logger,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('ssh.uploadFileOrFolder', async (uri?: vscode.Uri, items?: vscode.Uri[]) => {
      try {
        let selectedUris: vscode.Uri[] = items && items.length > 0 ? [...items] : (uri ? [uri] : []);

        if (selectedUris.length === 0) {
          const files = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFolders: true,
            title: 'Select files or folders to upload',
          });
          if (!files || files.length === 0) return;
          selectedUris = [...files];
        }

        const profiles = connectionManager.getAllProfiles();
        if (profiles.length === 0) {
          vscode.window.showWarningMessage('No SSH connections configured');
          return;
        }

        const connectedProfiles = profiles.filter(p => {
          const conn = connectionManager.getConnection(p.id);
          return conn?.status === ConnectionStatus.Connected;
        });

        const availableProfiles = connectedProfiles.length > 0 ? connectedProfiles : profiles;

        const selected = await vscode.window.showQuickPick(
          availableProfiles.map(p => ({
            label: p.name,
            description: `${p.username}@${p.host}`,
            profileId: p.id,
          })),
          { placeHolder: 'Select a connection' },
        );

        if (!selected) return;

        let conn = connectionManager.getConnection(selected.profileId);
        if (!conn || conn.status !== ConnectionStatus.Connected) {
          await connectionManager.connect(selected.profileId);
          conn = connectionManager.getConnection(selected.profileId);
          if (!conn || conn.status !== ConnectionStatus.Connected) {
            vscode.window.showErrorMessage('Failed to connect');
            return;
          }
        }

        const profile = conn.getProfile();
        const remoteRoot = profile.remotePath || '/';

        for (const item of selectedUris) {
          const stat = fs.statSync(item.fsPath);

          if (stat.isDirectory()) {
            const folderName = pathUtils.getFileName(item.fsPath);
            const remoteDir = pathUtils.joinRemotePath(remoteRoot, folderName);

            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `Uploading folder ${folderName}...`,
                cancellable: false,
              },
              async (progress) => {
                await conn!.uploadDirectory(item.fsPath, remoteDir, (p) => {
                  progress.report({ increment: p.percent / 100, message: `${p.percent}%` });
                });
              },
            );
            logger.info(`Uploaded directory ${item.fsPath} -> ${remoteDir}`);
          } else {
            const fileName = pathUtils.getFileName(item.fsPath);
            const remotePath = pathUtils.joinRemotePath(remoteRoot, fileName);

            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `Uploading ${fileName}...`,
                cancellable: false,
              },
              async (progress) => {
                await conn!.uploadFile(item.fsPath, remotePath, (p) => {
                  progress.report({ increment: p.percent / 100, message: `${p.percent}%` });
                });
              },
            );
            logger.info(`Uploaded file ${item.fsPath} -> ${remotePath}`);
          }
        }

        vscode.window.showInformationMessage(`Uploaded ${selectedUris.length} item(s) to ${profile.name}`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Upload failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.uploadFile', async (item?: RemoteDirectoryItem) => {
      try {
        const conn = await getActiveConnection(connectionManager);
        if (!conn) return;

        const targetDir = item?.fullPath || conn.getProfile().remotePath || '/';

        const files = await vscode.window.showOpenDialog({
          canSelectMany: true,
          title: 'Select files to upload',
        });

        if (!files || files.length === 0) return;

        for (const file of files) {
          const fileName = pathUtils.getFileName(file.fsPath);
          const remotePath = pathUtils.joinRemotePath(targetDir, fileName);

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Uploading ${fileName}...`,
              cancellable: false,
            },
            async (progress) => {
              await conn.uploadFile(file.fsPath, remotePath, (p) => {
                progress.report({ increment: p.percent / 100, message: `${p.percent}%` });
              });
            },
          );
          logger.info(`Uploaded ${file.fsPath} -> ${remotePath}`);
        }

        vscode.window.showInformationMessage(`Uploaded ${files.length} file(s)`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Upload failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.uploadFolder', async (item?: RemoteDirectoryItem) => {
      try {
        const conn = await getActiveConnection(connectionManager);
        if (!conn) return;

        const targetDir = item?.fullPath || conn.getProfile().remotePath || '/';

        const folders = await vscode.window.showOpenDialog({
          canSelectMany: true,
          canSelectFolders: true,
          canSelectFiles: false,
          title: 'Select folders to upload',
        });

        if (!folders || folders.length === 0) return;

        for (const folder of folders) {
          const folderName = pathUtils.getFileName(folder.fsPath);
          const remoteDir = pathUtils.joinRemotePath(targetDir, folderName);

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Uploading folder ${folderName}...`,
              cancellable: false,
            },
            async (progress) => {
              await conn!.uploadDirectory(folder.fsPath, remoteDir, (p) => {
                progress.report({ increment: p.percent / 100, message: `${p.percent}%` });
              });
            },
          );
          logger.info(`Uploaded directory ${folder.fsPath} -> ${remoteDir}`);
        }

        vscode.window.showInformationMessage(`Uploaded ${folders.length} folder(s)`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Upload failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.downloadFile', async (item: RemoteFileItem) => {
      try {
        if (!item) return;

        const conn = await getActiveConnection(connectionManager, item.connectionId);
        if (!conn) return;

        const folder = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          title: 'Select destination folder',
        });

        if (!folder || folder.length === 0) return;

        const localPath = pathUtils.joinRemotePath(folder[0].fsPath, item.info.name);

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Downloading ${item.info.name}...`,
            cancellable: false,
          },
          async (progress) => {
            await conn.downloadFile(item.fullPath, localPath, (p) => {
              progress.report({ increment: p.percent / 100, message: `${p.percent}%` });
            });
          },
        );

        logger.info(`Downloaded ${item.fullPath} -> ${localPath}`);
        vscode.window.showInformationMessage(`Downloaded to ${localPath}`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Download failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.openFile', async (item: RemoteFileItem, ...rest: RemoteFileItem[]) => {
      try {
        const items = rest.length > 0 ? [item, ...rest] : [item];

        for (const fileItem of items) {
          const conn = await getActiveConnection(connectionManager, fileItem.connectionId);
          if (!conn) continue;

          const uri = vscode.Uri.parse(`ssh://${fileItem.connectionId}${fileItem.fullPath}`);
          const doc = await vscode.workspace.openTextDocument(uri);
          // preview: false ensures each file opens in its own persistent tab
          await vscode.window.showTextDocument(doc, { preview: false });
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to open file: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.deleteFile', async (item: RemoteFileItem | RemoteDirectoryItem) => {
      try {
        if (!item) return;

        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to delete "${item.label}"?`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') return;

        const conn = await getActiveConnection(connectionManager, item.connectionId);
        if (!conn) return;

        if (item instanceof RemoteDirectoryItem) {
          await conn.deleteDirectory(item.fullPath);
        } else {
          await conn.deleteFile(item.fullPath);
        }

        logger.info(`Deleted ${item.fullPath}`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Delete failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.renameFile', async (item: RemoteFileItem | RemoteDirectoryItem) => {
      try {
        if (!item) return;

        const newName = await vscode.window.showInputBox({
          prompt: 'Enter new name',
          value: item.label as string,
        });

        if (!newName || newName === item.label) return;

        const conn = await getActiveConnection(connectionManager, item.connectionId);
        if (!conn) return;

        const dir = pathUtils.getDirectoryName(item.fullPath);
        const newPath = pathUtils.joinRemotePath(dir, newName);

        await conn.rename(item.fullPath, newPath);
        logger.info(`Renamed ${item.fullPath} -> ${newPath}`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Rename failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.createFolder', async (item: RemoteDirectoryItem) => {
      try {
        if (!item) return;

        const folderName = await vscode.window.showInputBox({
          prompt: 'Enter folder name',
        });

        if (!folderName) return;

        const conn = await getActiveConnection(connectionManager, item.connectionId);
        if (!conn) return;

        const fullPath = pathUtils.joinRemotePath(item.fullPath, folderName);
        await conn.createDirectory(fullPath);
        logger.info(`Created directory ${fullPath}`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Create folder failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.chmodFile', async (item: RemoteFileItem | RemoteDirectoryItem) => {
      try {
        if (!item) return;

        const conn = await getActiveConnection(connectionManager, item.connectionId);
        if (!conn) return;

        const currentMode = (item as any).info?.mode ?? 0;
        const bits = parseMode(currentMode & 0o7777);

        const selected = await showPermissionPicker(bits, item.label as string, item.fullPath, currentMode);
        if (!selected) return;

        const mode = selected.owner * 64 + selected.group * 8 + selected.other;
        await conn.setstat(item.fullPath, { mode });

        const label = `${selected.owner}${selected.group}${selected.other}`;
        logger.info(`Changed permission: ${item.fullPath} -> ${label} (mode=${mode})`);
        vscode.window.showInformationMessage(`Permission set to ${label}`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Change permission failed: ${err}`);
      }
    }),
  );

  // Listen for file saves and auto-upload workspace files
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme === 'file' && vscode.workspace.getConfiguration('ssh').get<boolean>('autoUpload', false)) {
        await syncEngine.uploadFile(doc.uri.fsPath);
      }
    }),
  );
}

interface PermBits {
  owner: number;
  group: number;
  other: number;
}

function parseMode(mode: number): PermBits {
  return {
    owner: (mode >> 6) & 7,
    group: (mode >> 3) & 7,
    other: mode & 7,
  };
}


async function showPermissionPicker(bits: PermBits, fileName: string, fullPath: string, _currentMode: number): Promise<PermBits | undefined> {
  const panel = vscode.window.createWebviewPanel(
    'sshPermissionEditor',
    `${fileName} — ${t('permission.title', fullPath)}`,
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  const ownerLabel = t('permission.owner');
  const groupLabel = t('permission.group');
  const otherLabel = t('permission.other');
  const readLabel = t('permission.read');
  const writeLabel = t('permission.write');
  const execLabel = t('permission.execute');

  const row = (label: string, key: string, b: number) => ({
    label,
    key,
    read: { r: !!(b & 4), w: !!(b & 2), x: !!(b & 1) },
  });

  const rows = [
    row(ownerLabel, 'owner', bits.owner),
    row(groupLabel, 'group', bits.group),
    row(otherLabel, 'other', bits.other),
  ];

  panel.webview.html = buildPermissionHtml(rows, fullPath, {
    ownerLabel, groupLabel, otherLabel, readLabel, writeLabel, execLabel,
  });

  return new Promise<PermBits | undefined>((resolve) => {
    let resolved = false;
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'save' && !resolved) {
        resolved = true;
        resolve(msg.bits as PermBits);
        panel.dispose();
      } else if (msg.type === 'cancel' && !resolved) {
        resolved = true;
        panel.dispose();
        resolve(undefined);
      }
    });
    panel.onDidDispose(() => {
      if (!resolved) {
        resolved = true;
        resolve(undefined);
      }
    });
  });
}

function buildPermissionHtml(
  rows: { label: string; key: string; read: { r: boolean; w: boolean; x: boolean } }[],
  fullPath: string,
  labels: { ownerLabel: string; groupLabel: string; otherLabel: string; readLabel: string; writeLabel: string; execLabel: string },
): string {
  const initData = JSON.stringify({ rows, fullPath, labels });

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
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
  }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family, sans-serif);
    padding: 20px;
    margin: 0;
  }
  .file-path {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 12px;
    margin-bottom: 16px;
    word-break: break-all;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 20px;
  }
  th {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .role-label {
    font-weight: 500;
    min-width: 80px;
  }
  label {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  input[type="checkbox"] {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }
  .octal-preview {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 14px;
    padding: 6px 12px;
    background: var(--input-bg);
    color: var(--input-fg);
    border-radius: 4px;
    display: inline-block;
    margin-bottom: 16px;
  }
  .button-row {
    display: flex;
    gap: 8px;
  }
  .btn {
    padding: 8px 20px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    color: var(--button-fg);
    background: var(--button-bg);
  }
  .btn:hover { background: var(--button-hover); }
  .btn-secondary {
    background: var(--secondary-bg);
    color: var(--vscode-button-secondaryForeground, #cccccc);
  }
  .btn-secondary:hover { background: var(--secondary-hover); }
</style>
</head>
<body>
  <div class="file-path" id="file-path"></div>
  <div class="octal-preview" id="octal"></div>
  <table>
    <thead>
      <tr><th></th><th id="th-read"></th><th id="th-write"></th><th id="th-execute"></th></tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
  <div class="button-row">
    <button class="btn" id="save">Apply</button>
    <button class="btn btn-secondary" id="cancel">Cancel</button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  var data = ${initData};

  document.getElementById('file-path').textContent = data.fullPath;
  document.getElementById('th-read').textContent = data.labels.readLabel;
  document.getElementById('th-write').textContent = data.labels.writeLabel;
  document.getElementById('th-execute').textContent = data.labels.execLabel;

  var tbody = document.getElementById('tbody');
  for (var i = 0; i < data.rows.length; i++) {
    var row = data.rows[i];
    var tr = document.createElement('tr');
    var tdRole = document.createElement('td');
    tdRole.className = 'role-label';
    tdRole.textContent = row.label;
    tr.appendChild(tdRole);
    var perms = [['r', 4], ['w', 2], ['x', 1]];
    for (var j = 0; j < perms.length; j++) {
      var permKey = perms[j][0];
      var bit = perms[j][1];
      var td = document.createElement('td');
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-key', row.key);
      cb.setAttribute('data-bit', String(bit));
      cb.checked = row.read[permKey];
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + data.labels[permKey === 'r' ? 'readLabel' : permKey === 'w' ? 'writeLabel' : 'execLabel']));
      td.appendChild(label);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  function computeBits() {
    var checks = document.querySelectorAll('input[type="checkbox"]');
    var result = { owner: 0, group: 0, other: 0 };
    for (var k = 0; k < checks.length; k++) {
      var cb = checks[k];
      if (cb.checked) {
        result[cb.getAttribute('data-key')] |= parseInt(cb.getAttribute('data-bit'), 10);
      }
    }
    return result;
  }

  function updateOctal() {
    var bits = computeBits();
    var oct = bits.owner * 64 + bits.group * 8 + bits.other;
    document.getElementById('octal').textContent = '0' + oct.toString(8);
  }

  document.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
    cb.addEventListener('change', updateOctal);
  });

  document.getElementById('save').addEventListener('click', function() {
    var bits = computeBits();
    vscode.postMessage({ type: 'save', bits: bits });
  });

  document.getElementById('cancel').addEventListener('click', function() {
    vscode.postMessage({ type: 'cancel' });
  });

  updateOctal();
</script>
</body>
</html>`;
}

async function getActiveConnection(
  connectionManager: ConnectionManager,
  connectionId?: string,
): Promise<SshConnection | undefined> {
  if (connectionId) {
    const conn = connectionManager.getConnection(connectionId);
    if (conn?.status === ConnectionStatus.Connected) {
      return conn;
    }
  }

  for (const profile of connectionManager.getAllProfiles()) {
    const conn = connectionManager.getConnection(profile.id);
    if (conn?.status === ConnectionStatus.Connected) {
      return conn;
    }
  }

  const profiles = connectionManager.getAllProfiles();
  if (profiles.length === 0) {
    vscode.window.showWarningMessage('No SSH connections configured');
    return;
  }

  const selected = await vscode.window.showQuickPick(
    profiles.map(p => ({ label: p.name, description: `${p.username}@${p.host}`, profileId: p.id })),
    { placeHolder: 'Select a connection' },
  );

  if (!selected) return undefined;

  await connectionManager.connect(selected.profileId);
  return connectionManager.getConnection(selected.profileId);
}
