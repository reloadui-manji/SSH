import * as vscode from 'vscode';
import * as fs from 'fs';
import { SshConnection } from './connection';
import { OpenSshConnection } from './openSshConnection';
import { profileHasCertificate, selectConnectionBackend } from './backendSelector';
import type { RemoteConnection } from './remoteConnection';
import { ConnectionProfile, ConnectionStatus, Protocol } from './protocol';
import { Logger } from '../utils/logger';

export class ConnectionManager {
  private readonly connections = new Map<string, RemoteConnection>();
  private readonly profiles = new Map<string, ConnectionProfile>();

  onProfilesChanged: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  onConnectionStatusChanged: vscode.EventEmitter<{ id: string; status: ConnectionStatus }> = new vscode.EventEmitter();

  constructor(private readonly logger: Logger) {}

  async initialize(): Promise<void> {
    this.loadFromSettings();
    this.watchSettings();
  }

  reload(): void {
    this.profiles.clear();
    this.loadFromSettings();
    this.logger.info('Connection profiles reloaded');
  }

  getProfile(id: string): ConnectionProfile | undefined {
    return this.profiles.get(id);
  }

  getAllProfiles(): ConnectionProfile[] {
    return Array.from(this.profiles.values());
  }

  getConnection(id: string): RemoteConnection | undefined {
    return this.connections.get(id);
  }

  async connect(profileId: string): Promise<RemoteConnection> {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    const existing = this.connections.get(profileId);
    if (existing && existing.status === ConnectionStatus.Connected) {
      return existing;
    }

    const hasCertificate = profileHasCertificate(profile, fs.existsSync);
    const backend = selectConnectionBackend(profile, fs.existsSync);
    const conn = backend === 'openssh'
      ? new OpenSshConnection(profile, this.logger)
      : new SshConnection(profile, this.logger);
    this.logger.info(
      `Selected ${backend} backend for ${profile.name} ` +
      `(profile backend: ${profile.backend || 'auto'}, certificate detected: ${hasCertificate})`,
    );
    if (backend === 'openssh' && !hasCertificate) {
      this.logger.warn(
        `OpenSSH backend selected for ${profile.name} but no SSH certificate was detected. ` +
        `Set ssh.defaultBackend/profile backend to "auto" or "ssh2" if this is a normal private-key connection.`,
      );
    }

    conn.onStatusChange = (status: ConnectionStatus) => {
      this.onConnectionStatusChanged.fire({ id: profileId, status });
    };
    conn.onDisconnected = () => {
      this.connections.delete(profileId);
      this.onConnectionStatusChanged.fire({ id: profileId, status: ConnectionStatus.Disconnected });
    };

    this.connections.set(profileId, conn);
    await conn.connect();
    return conn;
  }

  async disconnect(profileId: string): Promise<void> {
    const conn = this.connections.get(profileId);
    if (conn) {
      await conn.disconnect();
    }
  }

  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connections.keys()).map(id => this.disconnect(id));
    await Promise.allSettled(promises);
  }

  private loadFromSettings(): void {
    const connections = vscode.workspace.getConfiguration('ssh').get<Array<Partial<ConnectionProfile>>>('connections', []);
    const defaultProtocol = vscode.workspace.getConfiguration('ssh').get<string>('defaultProtocol', 'sftp') as Protocol;
    const defaultRemotePath = vscode.workspace.getConfiguration('ssh').get<string>('remotePath', '');
    const defaultBackend = vscode.workspace.getConfiguration('ssh').get<'auto' | 'ssh2' | 'openssh'>('defaultBackend', 'auto');

    for (const conn of connections) {
      if (!conn.host || !conn.username) continue;

      const id = conn.id || `manual-${conn.host}-${conn.port || 22}`;
      const profile: ConnectionProfile = {
        id,
        name: conn.name || `${conn.username}@${conn.host}`,
        host: conn.host,
        port: conn.port || 22,
        username: conn.username,
        protocol: conn.protocol || defaultProtocol,
        auth: conn.auth || { type: 'privateKey' },
        backend: conn.backend || defaultBackend,
        remotePath: conn.remotePath || defaultRemotePath,
        localPath: conn.localPath,
        connectTimeout: conn.connectTimeout,
        keepaliveInterval: conn.keepaliveInterval,
        concurrency: conn.concurrency,
        source: 'manual',
      };

      this.profiles.set(id, profile);
    }

    if (connections.length > 0) {
      this.onProfilesChanged.fire();
    }
  }

  private watchSettings(): void {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ssh')) {
        this.logger.info('SSH settings changed, reloading profiles...');
        this.reload();
      }
    });
  }

  dispose(): void {
    this.onProfilesChanged.dispose();
    this.onConnectionStatusChanged.dispose();
  }
}
