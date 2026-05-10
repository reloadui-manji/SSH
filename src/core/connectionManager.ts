import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SshConnection } from './connection';
import { ConnectionProfile, ConnectionStatus, Protocol } from './protocol';
import { SshConfigParserImpl } from './sshConfigParser';
import { Logger } from '../utils/logger';

export class ConnectionManager {
  private readonly connections = new Map<string, SshConnection>();
  private readonly profiles = new Map<string, ConnectionProfile>();
  private readonly configParser: SshConfigParserImpl;
  private configWatcher: vscode.FileSystemWatcher | null = null;

  onProfilesChanged: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  onConnectionStatusChanged: vscode.EventEmitter<{ id: string; status: ConnectionStatus }> = new vscode.EventEmitter();

  constructor(private readonly logger: Logger) {
    this.configParser = new SshConfigParserImpl(this.logger);
  }

  async initialize(): Promise<void> {
    const configPath = vscode.workspace.getConfiguration('ssh').get<string>('configPath', '~/.ssh/config');
    const resolvedPath = this.resolvePath(configPath);

    this.loadFromSshConfig(resolvedPath);
    this.loadFromSettings();
    this.watchSshConfig(resolvedPath);
    this.watchSettings();
  }

  reload(): void {
    const configPath = vscode.workspace.getConfiguration('ssh').get<string>('configPath', '~/.ssh/config');
    const resolvedPath = this.resolvePath(configPath);

    this.profiles.clear();
    this.loadFromSshConfig(resolvedPath);
    this.loadFromSettings();
    this.logger.info('Connection profiles reloaded');
  }

  getProfile(id: string): ConnectionProfile | undefined {
    return this.profiles.get(id);
  }

  getAllProfiles(): ConnectionProfile[] {
    return Array.from(this.profiles.values());
  }

  getConnection(id: string): SshConnection | undefined {
    return this.connections.get(id);
  }

  async connect(profileId: string): Promise<SshConnection> {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    const existing = this.connections.get(profileId);
    if (existing && existing.status === ConnectionStatus.Connected) {
      return existing;
    }

    const conn = new SshConnection(profile, this.logger);

    conn.onStatusChange = (status) => {
      this.onConnectionStatusChanged.fire({ id: profileId, status });
    };
    conn.onDisconnected = () => {
      this.onConnectionStatusChanged.fire({ id: profileId, status: ConnectionStatus.Disconnected });
    };

    await conn.connect();
    this.connections.set(profileId, conn);
    return conn;
  }

  async disconnect(profileId: string): Promise<void> {
    const conn = this.connections.get(profileId);
    if (conn) {
      await conn.disconnect();
      this.connections.delete(profileId);
    }
  }

  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connections.keys()).map(id => this.disconnect(id));
    await Promise.allSettled(promises);
  }

  private loadFromSshConfig(configPath: string): void {
    try {
      const profiles = this.configParser.parseFile(configPath);
      for (const profile of profiles) {
        this.profiles.set(profile.id, profile);
      }
      this.onProfilesChanged.fire();
    } catch (err) {
      this.logger.error(`Failed to load SSH config: ${err}`);
    }
  }

  private loadFromSettings(): void {
    const connections = vscode.workspace.getConfiguration('ssh').get<Array<Partial<ConnectionProfile>>>('connections', []);
    const defaultProtocol = vscode.workspace.getConfiguration('ssh').get<string>('defaultProtocol', 'sftp') as Protocol;

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
        remotePath: conn.remotePath,
        localPath: conn.localPath,
        connectTimeout: conn.connectTimeout,
        source: 'manual',
      };

      this.profiles.set(id, profile);
    }

    if (connections.length > 0) {
      this.onProfilesChanged.fire();
    }
  }

  private watchSshConfig(configPath: string): void {
    const resolvedPath = this.resolvePath(configPath);
    const dir = path.dirname(resolvedPath);
    const base = path.basename(resolvedPath);

    this.configWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, base),
    );

    this.configWatcher.onDidChange(() => {
      this.logger.info('SSH config changed, reloading...');
      this.reload();
    });

    this.configWatcher.onDidCreate(() => {
      this.logger.info('SSH config created, loading...');
      this.reload();
    });
  }

  private watchSettings(): void {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ssh.connections')) {
        this.logger.info('SSH settings changed, reloading profiles...');
        this.reload();
      }
    });
  }

  private resolvePath(p: string): string {
    if (p.startsWith('~')) {
      return path.join(os.homedir(), p.slice(1));
    }
    return p;
  }

  dispose(): void {
    this.configWatcher?.dispose();
    this.onProfilesChanged.dispose();
    this.onConnectionStatusChanged.dispose();
  }
}
