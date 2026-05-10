import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { ConnectionStatus } from '../core/protocol';
import { RemoteTreeItem, RemoteConnectionItem, RemoteDirectoryItem, RemoteFileItem } from './treeItems';
import { Logger } from '../utils/logger';

export class RemoteExplorerTreeProvider implements vscode.TreeDataProvider<RemoteTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<RemoteTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly connectionStatuses = new Map<string, ConnectionStatus>();

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly logger: Logger,
  ) {
    connectionManager.onConnectionStatusChanged.event(({ id, status }) => {
      this.connectionStatuses.set(id, status);
      this.onDidChangeTreeDataEmitter.fire(undefined);
    });

    connectionManager.onProfilesChanged.event(() => {
      this.onDidChangeTreeDataEmitter.fire(undefined);
    });
  }

  getTreeItem(element: RemoteTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RemoteTreeItem): Promise<RemoteTreeItem[]> {
    if (!element) {
      return this.getConnections();
    }

    if (element instanceof RemoteConnectionItem) {
      return this.getRootDirectory(element.profile.id);
    }

    if (element instanceof RemoteDirectoryItem) {
      return this.getDirectoryContents(element.connectionId, element.fullPath);
    }

    return [];
  }

  async getConnectionRoots(): Promise<RemoteConnectionItem[]> {
    return this.getConnections() as Promise<RemoteConnectionItem[]>;
  }

  private async getConnections(): Promise<RemoteConnectionItem[]> {
    const profiles = this.connectionManager.getAllProfiles();
    return profiles.map(profile => {
      const status = this.connectionStatuses.get(profile.id) || ConnectionStatus.Disconnected;
      return new RemoteConnectionItem(profile, status);
    });
  }

  private async getRootDirectory(connectionId: string): Promise<RemoteTreeItem[]> {
    const conn = this.connectionManager.getConnection(connectionId);
    if (!conn || conn.status !== ConnectionStatus.Connected) {
      return [];
    }

    const profile = conn.getProfile();
    const rootPath = profile.remotePath || '/';
    return this.getDirectoryContents(connectionId, rootPath);
  }

  private async getDirectoryContents(connectionId: string, remotePath: string): Promise<RemoteTreeItem[]> {
    const conn = this.connectionManager.getConnection(connectionId);
    if (!conn || conn.status !== ConnectionStatus.Connected) {
      return [];
    }

    try {
      const files = await conn.listFiles(remotePath);
      const items: RemoteTreeItem[] = [];

      const dirs = files.filter(f => f.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
      const filesOnly = files.filter(f => f.isFile).sort((a, b) => a.name.localeCompare(b.name));

      for (const dir of dirs) {
        items.push(new RemoteDirectoryItem(connectionId, dir, remotePath));
      }
      for (const file of filesOnly) {
        items.push(new RemoteFileItem(connectionId, file, remotePath));
      }

      return items;
    } catch (err) {
      this.logger.error(`Failed to list directory ${remotePath}: ${err}`);
      return [];
    }
  }

  refresh(element?: RemoteTreeItem): void {
    this.onDidChangeTreeDataEmitter.fire(element);
  }
}
