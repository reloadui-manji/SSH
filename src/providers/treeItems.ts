import * as vscode from 'vscode';
import { ConnectionProfile, ConnectionStatus } from '../core/protocol';
import { RemoteFileInfo } from '../core/connection';
import * as path from '../utils/path';

export abstract class RemoteTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsibleState);
  }
}

export class RemoteConnectionItem extends RemoteTreeItem {
  constructor(
    public readonly profile: ConnectionProfile,
    public readonly status: ConnectionStatus,
  ) {
    super(profile.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = profile.id;
    const sourceSuffix = profile.source === 'manual' ? '-manual' : '-config';
    this.contextValue = status === ConnectionStatus.Connected ? `connection-connected${sourceSuffix}` : `connection-disconnected${sourceSuffix}`;
    this.iconPath = status === ConnectionStatus.Connected
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiGreen'))
      : new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('terminal.ansiYellow'));
    this.description = `${profile.username}@${profile.host}:${profile.port}`;
    this.tooltip = `${profile.name}\nStatus: ${status}\nHost: ${profile.host}:${profile.port}\nProtocol: ${profile.protocol}`;
  }
}

export class RemoteDirectoryItem extends RemoteTreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly info: RemoteFileInfo,
    public readonly parentPath: string,
  ) {
    super(info.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `${connectionId}:${parentPath}/${info.name}`;
    this.contextValue = 'directory';
    this.iconPath = vscode.ThemeIcon.Folder;
    this.resourceUri = vscode.Uri.file(`${parentPath}/${info.name}`);
    this.tooltip = info.name;
    this.description = this.octalMode(info.mode);
    this.command = {
      command: 'ssh.refreshDirectory',
      title: 'Refresh',
      arguments: [this],
    };
  }

  get fullPath(): string {
    return path.joinRemotePath(this.parentPath, this.info.name);
  }

  private octalMode(mode: number): string {
    const octal = (mode & 0o7777).toString(8);
    return `0${octal}`;
  }
}

export class RemoteFileItem extends RemoteTreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly info: RemoteFileInfo,
    public readonly parentPath: string,
  ) {
    super(info.name, vscode.TreeItemCollapsibleState.None);
    this.id = `${connectionId}:${parentPath}/${info.name}`;
    this.contextValue = 'file';
    this.iconPath = vscode.ThemeIcon.File;
    this.resourceUri = vscode.Uri.file(`${parentPath}/${info.name}`);
    this.tooltip = `${info.name} (${this.formatSize(info.size)})`;
    this.description = this.octalMode(info.mode);
    this.command = {
      command: 'ssh.openFile',
      title: 'Open File',
      arguments: [this],
    };
  }

  get fullPath(): string {
    return path.joinRemotePath(this.parentPath, this.info.name);
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private octalMode(mode: number): string {
    const octal = (mode & 0o7777).toString(8);
    return `0${octal}`;
  }
}
