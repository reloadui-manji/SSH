export enum Protocol {
  SFTP = 'sftp',
  SCP = 'scp',
}

export interface AuthConfig {
  type: 'password' | 'privateKey' | 'agent' | 'keyboard-interactive';
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
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
  remotePath?: string;
  localPath?: string;
  connectTimeout?: number;
  keepaliveInterval?: number;
  concurrency?: number;
  source: 'config-file' | 'manual';
  configFilePath?: string;
}

export enum ConnectionStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Disconnecting = 'disconnecting',
  Error = 'error',
}
