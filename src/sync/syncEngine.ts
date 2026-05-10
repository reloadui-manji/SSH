import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { ConnectionStatus } from '../core/protocol';
import { FileWatcher } from './fileWatcher';
import * as pathUtils from '../utils/path';
import { Logger } from '../utils/logger';

export class SyncEngine {
  private readonly fileWatcher: FileWatcher;
  private readonly pendingUploads = new Map<string, { connectionId: string; remotePath: string }>();
  private activeConnectionId: string | null = null;
  private activeRemoteRoot: string = '/';

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly logger: Logger,
  ) {
    const delay = vscode.workspace.getConfiguration('ssh').get<number>('autoUploadDelay', 500);
    this.fileWatcher = new FileWatcher(delay, logger);
  }

  setDefaultConnection(connectionId: string, remoteRoot?: string): void {
    this.activeConnectionId = connectionId;
    this.activeRemoteRoot = remoteRoot || '/';
  }

  registerTempFile(localPath: string, connectionId: string, remotePath: string): void {
    this.pendingUploads.set(localPath, { connectionId, remotePath });
    this.logger.debug(`Registered temp file mapping: ${localPath} -> ${connectionId}:${remotePath}`);
  }

  async uploadTempFile(localPath: string): Promise<boolean> {
    const mapping = this.pendingUploads.get(localPath);
    if (!mapping) return false;

    const conn = this.connectionManager.getConnection(mapping.connectionId);
    if (!conn || conn.status !== ConnectionStatus.Connected) {
      this.logger.warn(`Connection ${mapping.connectionId} not connected, cannot upload ${localPath}`);
      return false;
    }

    try {
      await conn.uploadFile(localPath, mapping.remotePath);
      this.logger.info(`Uploaded ${localPath} -> ${mapping.remotePath}`);
      vscode.window.showInformationMessage(`Uploaded ${pathUtils.getFileName(mapping.remotePath)} to server`);
      return true;
    } catch (err) {
      this.logger.error(`Upload failed for ${localPath}: ${err}`);
      vscode.window.showErrorMessage(`Auto-upload failed: ${err}`);
      return false;
    }
  }

  async uploadFile(localPath: string): Promise<void> {
    if (!this.activeConnectionId) return;

    const conn = this.connectionManager.getConnection(this.activeConnectionId);
    if (!conn || conn.status !== ConnectionStatus.Connected) return;

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    if (!localPath.startsWith(workspacePath)) return;

    const relativePath = localPath.replace(workspacePath, '');
    const remotePath = pathUtils.joinRemotePath(this.activeRemoteRoot, relativePath);

    try {
      await conn.uploadFile(localPath, remotePath);
      this.logger.info(`Auto-uploaded ${localPath} -> ${remotePath}`);
    } catch (err) {
      this.logger.error(`Auto-upload failed for ${localPath}: ${err}`);
    }
  }

  startAutoUpload(): void {
    if (!vscode.workspace.workspaceFolders) return;

    const paths = vscode.workspace.workspaceFolders.map(f => f.uri.fsPath);
    const ignorePatterns = vscode.workspace.getConfiguration('ssh').get<string[]>('ignorePatterns', []);

    this.fileWatcher.watch(paths, (filePath) => {
      if (!this.activeConnectionId) return;
      this.uploadFile(filePath);
    }, ignorePatterns);
  }

  stopAutoUpload(): void {
    this.fileWatcher.stop();
  }

  dispose(): void {
    this.fileWatcher.dispose();
  }
}
