export enum Protocol {
  SFTP = 'sftp',
  SCP = 'scp',
}

export type ConnectionBackend = 'auto' | 'ssh2' | 'openssh';

export interface AuthConfig {
  type: 'password' | 'privateKey' | 'agent' | 'keyboard-interactive';
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  certificatePath?: string;
  passphrase?: string;
  agent?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  protocol: Protocol;
  auth: AuthConfig;
  backend?: ConnectionBackend;
  remotePath?: string;
  localPath?: string;
  connectTimeout?: number;
  keepaliveInterval?: number;
  concurrency?: number;
  source: 'manual';
}

export enum ConnectionStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Disconnecting = 'disconnecting',
  Error = 'error',
}
