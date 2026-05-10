import * as vscode from 'vscode';
import { ConnectionStatus } from '../core/protocol';

export class StatusBarManager {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly connections = new Map<string, { name: string; status: ConnectionStatus }>();

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.command = 'ssh.connect';
    this.statusBarItem.show();
    this.updateText();
  }

  updateConnectionStatus(id: string, name: string, status: ConnectionStatus): void {
    if (status === ConnectionStatus.Disconnected) {
      this.connections.delete(id);
    } else {
      this.connections.set(id, { name, status });
    }
    this.updateText();
  }

  private updateText(): void {
    const active = Array.from(this.connections.entries()).filter(
      ([, v]) => v.status === ConnectionStatus.Connected,
    );

    if (active.length === 0) {
      this.statusBarItem.text = '$(plug) SSH: Disconnected';
      this.statusBarItem.tooltip = 'No active SSH connections';
    } else {
      const names = active.map(([, v]) => v.name).join(', ');
      this.statusBarItem.text = `$(plug) SSH: ${active.length} connected`;
      this.statusBarItem.tooltip = `Connected to: ${names}`;
    }
  }

  show(): void {
    this.statusBarItem.show();
  }

  hide(): void {
    this.statusBarItem.hide();
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
