import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { ConnectionStatus } from '../core/protocol';
import * as uri from '../utils/uri';
import { Logger } from '../utils/logger';

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly logger: Logger,
  ) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(resource: vscode.Uri): Promise<vscode.FileStat> {
    const { connectionId, remotePath } = uri.parseUri(resource);
    const conn = await this.getConnectedConnection(connectionId);
    const info = await conn.stat(remotePath);

    const type = info.isDirectory
      ? vscode.FileType.Directory
      : vscode.FileType.File;

    return {
      type,
      ctime: 0,
      mtime: info.mtime * 1000,
      size: info.size,
    };
  }

  async readDirectory(resource: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { connectionId, remotePath } = uri.parseUri(resource);
    const conn = await this.getConnectedConnection(connectionId);
    const files = await conn.listFiles(remotePath);

    return files.map(f => [f.name, f.isDirectory ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async createDirectory(resource: vscode.Uri): Promise<void> {
    const { connectionId, remotePath } = uri.parseUri(resource);
    const conn = await this.getConnectedConnection(connectionId);
    await conn.createDirectory(remotePath);
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Created, uri: resource }]);
  }

  async readFile(resource: vscode.Uri): Promise<Uint8Array> {
    const { connectionId, remotePath } = uri.parseUri(resource);
    const conn = await this.getConnectedConnection(connectionId);
    const content = await conn.readFile(remotePath);
    return new Uint8Array(content);
  }

  async writeFile(
    resource: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const { connectionId, remotePath } = uri.parseUri(resource);
    this.logger.info(`Writing ${content.length} bytes to ${connectionId}:${remotePath} (create=${options.create}, overwrite=${options.overwrite})`);
    const conn = await this.getConnectedConnection(connectionId);

    try {
      await conn.stat(remotePath);
      // File exists, always allow overwrite for saves
    } catch {
      // File doesn't exist, need create flag
      if (!options.create) {
        throw vscode.FileSystemError.FileNotFound(resource);
      }
    }

    await conn.writeFile(remotePath, Buffer.from(content));
    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: resource }]);
    this.logger.info(`Written to ${connectionId}:${remotePath}`);
  }

  async delete(resource: vscode.Uri, _options: { recursive: boolean }): Promise<void> {
    const { connectionId, remotePath } = uri.parseUri(resource);
    const conn = await this.getConnectedConnection(connectionId);

    try {
      const stat = await conn.stat(remotePath);
      if (stat.isDirectory) {
        await conn.deleteDirectory(remotePath);
      } else {
        await conn.deleteFile(remotePath);
      }
    } catch (err) {
      throw vscode.FileSystemError.FileNotFound(resource);
    }

    this.onDidChangeFileEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri: resource }]);
  }

  async rename(oldResource: vscode.Uri, newResource: vscode.Uri): Promise<void> {
    const { connectionId, remotePath: oldPath } = uri.parseUri(oldResource);
    const newPath = uri.parseUri(newResource).remotePath;
    const conn = await this.getConnectedConnection(connectionId);

    await conn.rename(oldPath, newPath);
    this.onDidChangeFileEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldResource },
      { type: vscode.FileChangeType.Created, uri: newResource },
    ]);
  }

  private async getConnectedConnection(connectionId: string) {
    const conn = this.connectionManager.getConnection(connectionId);
    if (!conn || conn.status !== ConnectionStatus.Connected) {
      throw vscode.FileSystemError.Unavailable(`Not connected to ${connectionId}`);
    }
    return conn;
  }
}
