import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager } from '../core/connectionManager';
import type { RemoteConnection } from '../core/remoteConnection';
import { ConnectionStatus } from '../core/protocol';
import { SyncEngine } from '../sync/syncEngine';
import { parseSyncConfig } from '../sync/syncConfig';
import { Logger } from '../utils/logger';

interface SyncFileEntry {
  localPath: string;
  remotePath: string;
  relativePath: string;
  localMtime?: number;
  remoteMtime?: number;
  localSize?: number;
  remoteSize?: number;
  action: 'upload' | 'download' | 'conflict' | 'new-local' | 'new-remote' | 'identical';
}

export function registerSyncCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  syncEngine: SyncEngine,
  logger: Logger,
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
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          vscode.window.showWarningMessage('No workspace folder open');
          return;
        }

        const conn = await getActiveConnection(connectionManager);
        if (!conn) return;

        const profile = conn.getProfile();
        const remoteRoot = profile.remotePath || '/';

        // Try to load project sync config
        const syncConfigPath = path.join(workspaceFolder.uri.fsPath, '.ssh-sync.json');
        let includePatterns = ['**/*'];
        let excludePatterns: string[] = [];

        if (fs.existsSync(syncConfigPath)) {
          const config = parseSyncConfig(fs.readFileSync(syncConfigPath, 'utf-8'));
          syncEngine.setDefaultConnection(config.connectionId || profile.id, config.remoteRoot);
          includePatterns = config.sync.include;
          excludePatterns = config.sync.exclude;
        } else {
          syncEngine.setDefaultConnection(profile.id, remoteRoot);
          excludePatterns = vscode.workspace.getConfiguration('ssh').get<string[]>('ignorePatterns', []);
        }

        // Collect local files
        const localFiles = await collectLocalFiles(workspaceFolder.uri.fsPath, includePatterns, excludePatterns);
        if (localFiles.length === 0) {
          vscode.window.showInformationMessage('No files to sync');
          return;
        }

        let uploadedCount = 0;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Syncing to ${profile.name}...`,
            cancellable: true,
          },
          async (_progress, token) => {
            for (let i = 0; i < localFiles.length; i++) {
              if (token.isCancellationRequested) break;

              const localPath = localFiles[i];
              const relativePath = localPath.replace(workspaceFolder.uri.fsPath, '');
              const remotePath = `${remoteRoot}${relativePath}`;

              // Ensure remote directory exists
              const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
              if (remoteDir) {
                await conn.createDirectory(remoteDir).catch(() => {});
              }

              await conn.uploadFile(localPath, remotePath);
              uploadedCount++;

              _progress.report({
                message: `${uploadedCount}/${localFiles.length} ${relativePath}`,
                increment: (100 / localFiles.length),
              });
            }
          },
        );

        vscode.window.showInformationMessage(`已同步 ${uploadedCount} 个文件到 ${profile.name}`);
        logger.info(`Sync up: ${uploadedCount} files uploaded to ${profile.name}`);
      } catch (err) {
        vscode.window.showErrorMessage(`同步失败: ${err}`);
        logger.error(`Sync up failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.syncDown', async () => {
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          vscode.window.showWarningMessage('No workspace folder open');
          return;
        }

        const conn = await getActiveConnection(connectionManager);
        if (!conn) return;

        const profile = conn.getProfile();
        const remoteRoot = profile.remotePath || '/';

        // Try to load project sync config
        const syncConfigPath = path.join(workspaceFolder.uri.fsPath, '.ssh-sync.json');
        let excludePatterns: string[] = [];

        if (fs.existsSync(syncConfigPath)) {
          const config = parseSyncConfig(fs.readFileSync(syncConfigPath, 'utf-8'));
          excludePatterns = config.sync.exclude;
        } else {
          excludePatterns = vscode.workspace.getConfiguration('ssh').get<string[]>('ignorePatterns', []);
        }

        // Collect remote files
        const remoteFiles = await collectRemoteFiles(conn, remoteRoot, excludePatterns);
        if (remoteFiles.length === 0) {
          vscode.window.showInformationMessage('No remote files to sync');
          return;
        }

        let downloadedCount = 0;
        const localRoot = workspaceFolder.uri.fsPath;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Syncing from ${profile.name}...`,
            cancellable: true,
          },
          async (_progress, token) => {
            for (let i = 0; i < remoteFiles.length; i++) {
              if (token.isCancellationRequested) break;

              const remotePath = remoteFiles[i];
              const relativePath = remotePath.replace(remoteRoot, '');
              const localPath = `${localRoot}${relativePath}`;

              // Ensure local directory exists
              const localDir = path.dirname(localPath);
              if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
              }

              await conn.downloadFile(remotePath, localPath);
              downloadedCount++;

              _progress.report({
                message: `${downloadedCount}/${remoteFiles.length} ${relativePath}`,
                increment: (100 / remoteFiles.length),
              });
            }
          },
        );

        vscode.window.showInformationMessage(`已从 ${profile.name} 同步 ${downloadedCount} 个文件到本地`);
        logger.info(`Sync down: ${downloadedCount} files downloaded from ${profile.name}`);
      } catch (err) {
        vscode.window.showErrorMessage(`同步失败: ${err}`);
        logger.error(`Sync down failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('ssh.syncDiff', async () => {
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          vscode.window.showWarningMessage('No workspace folder open');
          return;
        }

        const conn = await getActiveConnection(connectionManager);
        if (!conn) return;

        const profile = conn.getProfile();
        const remoteRoot = profile.remotePath || '/';
        const localRoot = workspaceFolder.uri.fsPath;

        // Collect both local and remote files
        const localFiles = await collectLocalFiles(localRoot, ['**/*'], []);
        const remoteFiles = await collectRemoteFiles(conn, remoteRoot, []);

        const diffEntries: SyncFileEntry[] = [];

        // Check local files against remote
        for (const localPath of localFiles) {
          const relativePath = localPath.replace(localRoot, '');
          const remotePath = `${remoteRoot}${relativePath}`;

          const localStat = fs.statSync(localPath);
          let remoteExists = false;
          let remoteStat: { mtime: number; size: number } | null = null;

          try {
            remoteStat = await conn.stat(remotePath);
            remoteExists = true;
          } catch {
            remoteExists = false;
          }

          if (!remoteExists) {
            diffEntries.push({
              localPath, remotePath, relativePath,
              localMtime: localStat.mtimeMs,
              localSize: localStat.size,
              action: 'new-local',
            });
          } else if (remoteStat) {
            const localMtime = localStat.mtimeMs;
            const remoteMtime = remoteStat.mtime * 1000;
            const isDifferent = Math.abs(localMtime - remoteMtime) > 1000 || localStat.size !== remoteStat.size;

            if (isDifferent) {
              const isLocalNewer = localMtime > remoteMtime;
              diffEntries.push({
                localPath, remotePath, relativePath,
                localMtime, remoteMtime: remoteStat.mtime,
                localSize: localStat.size, remoteSize: remoteStat.size,
                action: isLocalNewer ? 'upload' : 'download',
              });
            } else {
              diffEntries.push({
                localPath, remotePath, relativePath,
                localMtime, remoteMtime: remoteStat.mtime,
                localSize: localStat.size, remoteSize: remoteStat.size,
                action: 'identical',
              });
            }
          }
        }

        // Check remote files not in local
        for (const remotePath of remoteFiles) {
          const relativePath = remotePath.replace(remoteRoot, '');
          const localPath = `${localRoot}${relativePath}`;

          if (!localFiles.some(lp => lp.replace(localRoot, '') === relativePath)) {
            try {
              const remoteStat = await conn.stat(remotePath);
              diffEntries.push({
                localPath, remotePath, relativePath,
                remoteMtime: remoteStat.mtime,
                remoteSize: remoteStat.size,
                action: 'new-remote',
              });
            } catch { /* skip */ }
          }
        }

        // Show diff in a webview
        showDiffWebview(diffEntries, profile.name, conn);
      } catch (err) {
        vscode.window.showErrorMessage(`差异对比失败: ${err}`);
        logger.error(`Sync diff failed: ${err}`);
      }
    }),
  );
}

async function collectLocalFiles(rootPath: string, includePatterns: string[], excludePatterns: string[]): Promise<string[]> {
  const files: string[] = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = fullPath.replace(rootPath, '');

      if (excludePatterns.some(p => matchesPattern(relativePath, p))) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (includePatterns.some(p => matchesPattern(relativePath, p))) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(rootPath);
  return files;
}

function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**/*') return true;
  if (pattern.startsWith('**/')) {
    return filePath.endsWith(pattern.slice(3));
  }
  if (pattern.startsWith('*.')) {
    return filePath.endsWith(pattern.slice(1));
  }
  return filePath.includes(pattern);
}

async function collectRemoteFiles(conn: RemoteConnection, remoteRoot: string, excludePatterns: string[]): Promise<string[]> {
  const files: string[] = [];

  async function walk(remotePath: string) {
    try {
      const entries = await conn.listFiles(remotePath);
      for (const entry of entries) {
        const fullPath = `${remotePath.replace(/\/+$/, '')}/${entry.name}`;
        const relativePath = fullPath.replace(remoteRoot, '');

        if (excludePatterns.some(p => matchesPattern(relativePath, p))) continue;

        if (entry.isDirectory && !entry.isFile) {
          await walk(fullPath);
        } else if (entry.isFile) {
          files.push(fullPath);
        }
      }
    } catch { /* skip unreadable directories */ }
  }

  await walk(remoteRoot);
  return files;
}

async function showDiffWebview(entries: SyncFileEntry[], connectionName: string, conn: RemoteConnection): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'sshSyncDiff',
    `同步差异 — ${connectionName}`,
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  const uploadCount = entries.filter(e => e.action === 'upload' || e.action === 'new-local').length;
  const downloadCount = entries.filter(e => e.action === 'download' || e.action === 'new-remote').length;
  const identicalCount = entries.filter(e => e.action === 'identical').length;

  const rows = entries.map(e => {
    const actionLabel: Record<string, string> = {
      upload: '本地更新', download: '远程更新',
      'new-local': '仅本地', 'new-remote': '仅远程',
      identical: '相同', conflict: '冲突',
    };
    const actionColor: Record<string, string> = {
      upload: '#4caf50', download: '#2196f3',
      'new-local': '#4caf50', 'new-remote': '#2196f3',
      identical: '#888', conflict: '#f44336',
    };

    const remoteMtime = e.remoteMtime ? new Date(e.remoteMtime * (e.remoteMtime > 1e12 ? 1 : 1000)).toLocaleString() : '-';

    const encPath = encodeURIComponent(e.relativePath);
    return `<tr>
      <td class="path">${e.relativePath}</td>
      <td style="color:${actionColor[e.action]}">${actionLabel[e.action]}</td>
      <td>${e.localSize !== undefined ? formatBytes(e.localSize) : '-'}</td>
      <td>${e.remoteSize !== undefined ? formatBytes(e.remoteSize) : '-'}</td>
      <td>${e.localMtime ? new Date(e.localMtime).toLocaleString() : '-'}</td>
      <td>${remoteMtime}</td>
      <td>
        ${(e.action === 'upload' || e.action === 'new-local') ? `<button class="btn-sm" onclick="upload('${encPath}')">上传</button>` : ''}
        ${(e.action === 'download' || e.action === 'new-remote') ? `<button class="btn-sm" onclick="download('${encPath}')">下载</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const localRoot = workspaceFolder ? workspaceFolder.uri.fsPath : '';
  const profile = conn.getProfile();
  const remoteRoot = profile.remotePath || '/';

  panel.webview.html = `<!DOCTYPE html>
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
    --button-bg: var(--vscode-button-background, #0e639c);
    --button-fg: var(--vscode-button-foreground, #ffffff);
    --button-hover: var(--vscode-button-hoverBackground, #1177bb);
  }
  body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family, sans-serif); padding: 20px; margin: 0; }
  h2 { font-size: 16px; margin: 0 0 8px; }
  .summary { display: flex; gap: 16px; margin-bottom: 16px; font-size: 13px; }
  .summary span { padding: 4px 12px; border-radius: 4px; background: var(--input-bg); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: var(--input-bg); }
  .btn-sm { padding: 2px 8px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; color: var(--button-fg); background: var(--button-bg); }
  .btn-sm:hover { background: var(--button-hover); }
  .path { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
</style>
</head>
<body>
  <h2>同步差异 — ${connectionName}</h2>
  <div class="summary">
    <span>本地更新: ${uploadCount}</span>
    <span>远程更新: ${downloadCount}</span>
    <span>相同: ${identicalCount}</span>
  </div>
  <table>
    <thead>
      <tr><th>文件路径</th><th>差异</th><th>本地大小</th><th>远程大小</th><th>本地修改时间</th><th>远程修改时间</th><th>操作</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
<script>
  var vscode = acquireVsCodeApi();
  function upload(p) { vscode.postMessage({ type: 'upload', path: decodeURIComponent(p) }); }
  function download(p) { vscode.postMessage({ type: 'download', path: decodeURIComponent(p) }); }
</script>
</body>
</html>`;

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'upload') {
      const relativePath = msg.path;
      const localPath = `${localRoot}${relativePath}`;
      const remotePath = `${remoteRoot}${relativePath}`;
      try {
        await conn.uploadFile(localPath, remotePath);
        vscode.window.showInformationMessage(`已上传 ${relativePath}`);
      } catch (err) {
        vscode.window.showErrorMessage(`上传失败: ${err}`);
      }
    } else if (msg.type === 'download') {
      const relativePath = msg.path;
      const localPath = `${localRoot}${relativePath}`;
      const remotePath = `${remoteRoot}${relativePath}`;
      try {
        const localDir = path.dirname(localPath);
        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
        await conn.downloadFile(remotePath, localPath);
        vscode.window.showInformationMessage(`已下载 ${relativePath}`);
      } catch (err) {
        vscode.window.showErrorMessage(`下载失败: ${err}`);
      }
    }
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function getActiveConnection(connectionManager: ConnectionManager): Promise<RemoteConnection | undefined> {
  for (const profile of connectionManager.getAllProfiles()) {
    const conn = connectionManager.getConnection(profile.id);
    if (conn?.status === ConnectionStatus.Connected) {
      return conn;
    }
  }

  const profiles = connectionManager.getAllProfiles();
  if (profiles.length === 0) {
    vscode.window.showWarningMessage('No SSH connections configured');
    return undefined;
  }

  if (profiles.length === 1) {
    await connectionManager.connect(profiles[0].id);
    return connectionManager.getConnection(profiles[0].id);
  }

  const selected = await vscode.window.showQuickPick(
    profiles.map(p => ({ label: p.name, description: `${p.username}@${p.host}`, profileId: p.id })),
    { placeHolder: '选择连接' },
  );

  if (!selected) return undefined;

  await connectionManager.connect(selected.profileId);
  return connectionManager.getConnection(selected.profileId);
}
