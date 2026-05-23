import * as vscode from 'vscode';
import { Client, SFTPWrapper, Channel, utils as ssh2Utils } from 'ssh2';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConnectionProfile, ConnectionStatus, Protocol } from './protocol';
import type { RemoteConnection } from './remoteConnection';
import { getSavedPassphrase, setSavedPassphrase } from './passphraseStore';
import { Logger } from '../utils/logger';
import * as pathUtils from '../utils/path';

export interface RemoteFileInfo {
  name: string;
  longname: string;
  size: number;
  mode: number;
  modifyTime: number;
  accessTime: number;
  isDirectory: boolean;
  isFile: boolean;
}

export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
}

export class SshConnection implements RemoteConnection {
  private client: Client;
  private sftp: SFTPWrapper | null = null;
  private _shellChannel: Channel | null = null;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  get shellChannel(): Channel | null { return this._shellChannel; }
  private statusValue: ConnectionStatus = ConnectionStatus.Disconnected;

  onStatusChange: ((status: ConnectionStatus) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly logger: Logger,
  ) {
    this.client = new Client();
    this.setupClientEvents();
  }

  async connect(): Promise<void> {
    this.setStatus(ConnectionStatus.Connecting);

    // If using an encrypted private key without a passphrase, prompt the user
    const auth = this.profile.auth;
    if (auth.type === 'privateKey' && !auth.passphrase) {
      let keyData: Buffer | undefined;
      let keyPath: string | undefined;
      if (auth.privateKey) {
        keyData = Buffer.from(auth.privateKey);
      } else if (auth.privateKeyPath) {
        try {
          keyData = fs.readFileSync(auth.privateKeyPath);
          keyPath = auth.privateKeyPath;
        } catch {}
      }
      if (keyData && this.isKeyEncrypted(keyData)) {
        // Check for a saved passphrase first
        const savedPassphrase = getSavedPassphrase(keyPath || '');

        if (savedPassphrase) {
          (this.profile.auth as any).passphrase = savedPassphrase;
          this.logger.info('Using saved passphrase for encrypted key');
        } else {
          const passphrase = await vscode.window.showInputBox({
            prompt: `Enter passphrase for ${keyPath || 'private key'} (will be saved)`,
            password: true,
            ignoreFocusOut: true,
            placeHolder: 'SSH key passphrase (leave empty to use SSH agent)',
          });
          if (passphrase) {
            (this.profile.auth as any).passphrase = passphrase;
            // Save passphrase for future connections
            if (keyPath) {
              await setSavedPassphrase(keyPath, passphrase);
              this.logger.info(`Passphrase saved for ${keyPath}`);
            }
          } else {
            this.logger.info('User cancelled passphrase prompt, will try SSH agent');
          }
        }
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = this.profile.connectTimeout || 10000;
      const timer = setTimeout(() => {
        this.setStatus(ConnectionStatus.Error);
        reject(new Error(`Connection timeout after ${timeout}ms`));
      }, timeout);

      this.client.once('ready', () => {
        clearTimeout(timer);

        this.logger.info(`Connected to ${this.profile.name} (${this.profile.host}:${this.profile.port})`);
        this.setStatus(ConnectionStatus.Connected);
        this.onConnected?.();

        if (connectConfig.privateKey && typeof connectConfig.privateKey === 'string') {
          connectConfig.privateKey = '';
        }
        if (connectConfig.passphrase) {
          connectConfig.passphrase = '';
        }
        resolve();
      });

      this.client.once('error', (err) => {
        clearTimeout(timer);

        this.setStatus(ConnectionStatus.Error);
        if (connectConfig.privateKey && typeof connectConfig.privateKey === 'string') {
          connectConfig.privateKey = '';
        }
        if (connectConfig.passphrase) {
          connectConfig.passphrase = '';
        }
        const wrappedErr = err instanceof Error ? err : new Error(String(err));
        const errAny = err as any;
        const details: string[] = [];
        if (errAny.level) details.push(`level=${errAny.level}`);
        if (errAny.authMethod) details.push(`method=${errAny.authMethod}`);
        if (errAny.methodsLeft) details.push(`methodsLeft=${errAny.methodsLeft}`);
        details.push(`auth=${this.profile.auth.type}`);
        this.logger.error(`Connection error for ${this.profile.name}: ${wrappedErr.message} (${details.join(', ')})`);
        this.onError?.(wrappedErr);
        reject(wrappedErr);
      });

      this.client.once('close', () => {
        if (this.statusValue === ConnectionStatus.Connected) {
          this.setStatus(ConnectionStatus.Disconnected);
          this.onDisconnected?.();
        }
      });

      const connectConfig: Parameters<Client['connect']>[0] = {
        host: this.profile.host,
        port: this.profile.port,
        username: this.profile.username,
        readyTimeout: timeout,
        keepaliveInterval: this.profile.keepaliveInterval || 30000,
        debug: (msg: string) => {
          this.logger.info(`[ssh2] ${msg}`);
        },
      };

      this.applyAuth(connectConfig);

      // Register keyboard-interactive handler for tryKeyboard fallback
      this.client.on('keyboard-interactive', async (name, instructions, _instructionsLang, prompts, finish) => {
        this.logger.info(`Keyboard-interactive: name="${name}", instructions="${instructions}", ${prompts.length} prompt(s)`);
        const responses: string[] = [];
        for (let i = 0; i < prompts.length; i++) {
          const prompt = prompts[i];
          // If we have a stored password and this is a password prompt, use it
          if (this.profile.auth.type === 'password' && this.profile.auth.password && !prompt.echo) {
            responses.push(this.profile.auth.password);
            this.logger.info(`Keyboard-interactive: auto-responded to prompt "${prompt.prompt}" with stored password`);
          } else {
            const response = await vscode.window.showInputBox({
              prompt: `${name}: ${prompt.prompt}`,
              password: !prompt.echo,
              placeHolder: prompt.prompt,
              ignoreFocusOut: true,
            });
            if (response === undefined) {
              this.logger.warn('Keyboard-interactive: user cancelled prompt');
              finish([]);
              return;
            }
            responses.push(response);
          }
        }
        finish(responses);
      });

      const authMethods: string[] = [];
      if (connectConfig.password) authMethods.push('password');
      if (connectConfig.privateKey) authMethods.push('privateKey');
      if (connectConfig.agent) authMethods.push('agent');
      if (connectConfig.passphrase) authMethods.push('passphrase');
      if (connectConfig.tryKeyboard) authMethods.push('tryKeyboard');
      this.logger.info(
        `Connecting to ${this.profile.name} (${this.profile.host}:${this.profile.port}) ` +
        `as ${this.profile.username} · auth type: ${this.profile.auth.type} · ` +
        `configured methods: [${authMethods.join(', ') || 'none'}] · ` +
        `SSH_AUTH_SOCK: ${process.env.SSH_AUTH_SOCK ? 'set' : 'not set'}`,
      );

      this.client.connect(connectConfig);
    });
  }

  async disconnect(): Promise<void> {
    this.setStatus(ConnectionStatus.Disconnecting);
    this.sftp = null;
    this._shellChannel = null;
    this.client.end();
    this.setStatus(ConnectionStatus.Disconnected);
    this.onDisconnected?.();
  }

  async listFiles(remotePath: string): Promise<RemoteFileInfo[]> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);
        resolve(list.map(item => ({
          name: item.filename,
          longname: item.longname,
          size: item.attrs.size,
          mode: item.attrs.mode,
          modifyTime: item.attrs.mtime,
          accessTime: item.attrs.atime,
          isDirectory: item.attrs.isDirectory?.() ?? false,
          isFile: item.attrs.isFile?.() ?? true,
        })));
      });
    });
  }

  async downloadFile(remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
    const sftp = await this.getSftp();
    const stat = await this.stat(remotePath);

    return new Promise((resolve, reject) => {
      const readStream = sftp.createReadStream(remotePath);
      const writeStream = fs.createWriteStream(localPath);
      let bytesTransferred = 0;

      readStream.on('data', (chunk: string | Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesTransferred += buf.length;
        if (onProgress) {
          onProgress({
            bytesTransferred,
            totalBytes: stat.size,
            percent: Math.round((bytesTransferred / stat.size) * 100),
          });
        }
      });

      readStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      readStream.pipe(writeStream);
    });
  }

  async uploadDirectory(localDir: string, remoteDir: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
    const totalFiles = this.countFiles(localDir);
    let uploadedFiles = 0;

    if (totalFiles === 0) {
      await this.createDirectory(remoteDir);
      onProgress?.({ bytesTransferred: 0, totalBytes: 0, percent: 100 });
      return;
    }

    const reportProgress = () => {
      onProgress?.({
        bytesTransferred: uploadedFiles,
        totalBytes: totalFiles,
        percent: Math.round((uploadedFiles / totalFiles) * 100),
      });
    };

    try {
      await this.uploadDirectoryRecursive(localDir, remoteDir, reportProgress, () => { uploadedFiles++; });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Upload directory failed: ${localDir} -> ${remoteDir}: ${detail}`);
    }

    onProgress?.({ bytesTransferred: uploadedFiles, totalBytes: totalFiles, percent: 100 });
  }

  async uploadFile(localPath: string, remotePath: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
    const sftp = await this.getSftp();
    const stat = fs.statSync(localPath);

    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath);
      let bytesTransferred = 0;
      let errored = false;

      const handleError = (source: string) => (err: Error) => {
        if (errored) return;
        errored = true;
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(`Upload failed: ${localPath} -> ${remotePath} [${source}]: ${detail}`);
        reject(new Error(`Upload ${source} error: ${detail}`));
      };

      readStream.on('error', handleError('read'));
      writeStream.on('error', handleError('write'));

      readStream.on('data', (chunk: string | Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesTransferred += buf.length;
        if (onProgress) {
          try {
            onProgress({
              bytesTransferred,
              totalBytes: stat.size,
              percent: stat.size > 0 ? Math.round((bytesTransferred / stat.size) * 100) : 100,
            });
          } catch {}
        }
      });

      let resolved = false;
      const complete = () => {
        if (resolved || errored) return;
        resolved = true;
        try {
          onProgress?.({ bytesTransferred: stat.size, totalBytes: stat.size, percent: 100 });
        } catch {}
        resolve();
      };
      writeStream.on('close', complete);
      writeStream.on('finish', complete);
      readStream.on('end', () => writeStream.end());
      setTimeout(() => { if (!resolved && !errored) complete(); }, 10000);

      readStream.pipe(writeStream, { end: false });
    });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const readStream = sftp.createReadStream(remotePath);
      readStream.on('data', (chunk: string | Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buf);
      });
      readStream.on('error', reject);
      readStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    const sftp = await this.getSftp();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`writeFile timeout for ${remotePath}`));
      }, 30000);

      const writeStream = sftp.createWriteStream(remotePath, { autoClose: true });
      writeStream.once('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
      writeStream.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      writeStream.end(content);
    });
  }

  async createDirectory(remotePath: string): Promise<void> {
    const sftp = await this.getSftp();
    const normalized = remotePath.replace(/\/+$/, '').replace(/\/+/g, '/');
    const segments = normalized.split('/').filter(s => s.length > 0);
    let current = normalized.startsWith('/') ? '/' : '';

    for (const seg of segments) {
      current = current === '/' ? `/${seg}` : `${current}/${seg}`;
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (err: any) => {
          if (!err) return resolve();
          // SFTP v3 has no FILE_ALREADY_EXISTS code — use stat to check if it's an existing directory
          sftp.stat(current, (statErr: any) => {
            if (statErr) {
              reject(new Error(`mkdir "${current}" failed: ${err.message}`));
            } else {
              resolve(); // Directory already exists, not an error
            }
          });
        });
      });
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.unlink(remotePath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);
        if (list.length === 0) {
          sftp.rmdir(remotePath, (err) => {
            if (err) return reject(err);
            resolve();
          });
          return;
        }
        const deleteAll = list.map(item => {
          const fullPath = `${remotePath.replace(/\/+$/, '')}/${item.filename}`;
          if (item.attrs.isDirectory?.()) {
            return this.deleteDirectory(fullPath);
          }
          return new Promise<void>((res, rej) => {
            sftp.unlink(fullPath, (err) => {
              if (err) return rej(err);
              res();
            });
          });
        });
        Promise.all(deleteAll)
          .then(() => {
            sftp.rmdir(remotePath, (err) => {
              if (err) return reject(err);
              resolve();
            });
          })
          .catch(reject);
      });
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sftp.rename(oldPath, newPath, (err: any) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async chmod(remotePath: string, mode: number): Promise<void> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.chmod(remotePath, mode, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async setstat(remotePath: string, attrs: { mode?: number; uid?: number; gid?: number }): Promise<void> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.setstat(remotePath, attrs, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async getStat(remotePath: string): Promise<{ size: number; mode: number; uid: number; gid: number; isDirectory: boolean; isFile: boolean; mtime: number; atime: number }> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) return reject(err);
        resolve({
          size: stats.size,
          mode: stats.mode,
          uid: (stats as any).uid ?? -1,
          gid: (stats as any).gid ?? -1,
          isDirectory: stats.isDirectory?.() ?? false,
          isFile: stats.isFile?.() ?? true,
          mtime: stats.mtime,
          atime: stats.atime,
        });
      });
    });
  }

  async checkExists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  async stat(remotePath: string): Promise<{ size: number; isDirectory: boolean; isFile: boolean; mtime: number }> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) return reject(err);
        resolve({
          size: stats.size,
          isDirectory: stats.isDirectory?.() ?? false,
          isFile: stats.isFile?.() ?? true,
          mtime: stats.mtime,
        });
      });
    });
  }

  async createShellStream(_size: { columns?: number; rows?: number } = {}): Promise<Channel> {
    return new Promise((resolve, reject) => {
      this.client.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) return reject(err);
        this._shellChannel = stream;
        resolve(stream);
      });
    });
  }

  private countFiles(dir: string): number {
    let count = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += this.countFiles(fullPath);
      } else {
        count++;
      }
    }
    return count;
  }

  private async uploadDirectoryRecursive(
    localDir: string,
    remoteDir: string,
    onProgress: () => void,
    onFileUploaded: () => void,
  ): Promise<void> {
    await this.createDirectory(remoteDir);

    const entries = fs.readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name);
      const remotePath = pathUtils.joinRemotePath(remoteDir, entry.name);

      if (entry.isDirectory()) {
        await this.uploadDirectoryRecursive(localPath, remotePath, onProgress, onFileUploaded);
      } else {
        await this.uploadFile(localPath, remotePath);
        onFileUploaded();
        onProgress();
      }
    }
  }

  getProfile(): ConnectionProfile {
    return this.profile;
  }

  private setStatus(status: ConnectionStatus): void {
    this.statusValue = status;
    this.onStatusChange?.(status);
  }

  private async getSftp(): Promise<SFTPWrapper> {
    if (this.sftp) return this.sftp;

    if (this.profile.protocol !== Protocol.SFTP) {
      throw new Error('SFTP operations not available for SCP protocol');
    }

    return new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        this.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  private setupClientEvents(): void {
    this.client.on('error', (err) => {
      this.logger.error(`SSH client error: ${err.message}`);
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    this.client.on('end', () => {
      this.logger.info(`SSH connection ended: ${this.profile.name}`);
    });
  }

  private static readonly DEFAULT_KEY_NAMES = [
    'id_ed25519',
    'id_rsa',
    'id_ecdsa',
    'id_ecdsa_sk',
    'id_ed25519_sk',
    'id_dsa',
  ];

  private findDefaultKey(): string | undefined {
    const sshDir = path.join(os.homedir(), '.ssh');
    for (const name of SshConnection.DEFAULT_KEY_NAMES) {
      const keyPath = path.join(sshDir, name);
      if (fs.existsSync(keyPath)) {
        // Skip .pub files that might match
        if (fs.statSync(keyPath).isFile()) {
          this.logger.info(`Found default key: ${keyPath}`);
          return keyPath;
        }
      }
    }
    return undefined;
  }

  private isKeyEncrypted(keyData: Buffer): boolean {
    const header = keyData.toString('utf-8', 0, 200);
    // Traditional PEM format encrypted keys contain 'ENCRYPTED' in the header
    if (header.includes('ENCRYPTED')) {
      this.logger.info('Key detection: traditional PEM encrypted key (contains ENCRYPTED header)');
      return true;
    }
    // OpenSSH format keys: use ssh2's parseKey to check if a passphrase is needed
    if (header.includes('BEGIN OPENSSH PRIVATE KEY')) {
      try {
        const result = ssh2Utils.parseKey(keyData);
        const isEncrypted = result instanceof Error;
        this.logger.info(`Key detection: OpenSSH format key, encrypted=${isEncrypted}${isEncrypted ? ` (${result.message})` : ''}`);
        return isEncrypted;
      } catch (e: any) {
        this.logger.warn(`Key detection: OpenSSH parse failed, assuming encrypted: ${e.message}`);
        return true;
      }
    }
    this.logger.info('Key detection: unencrypted key (PEM format without ENCRYPTED header)');
    return false;
  }

  private applyAuth(config: Parameters<Client['connect']>[0]): void {
    const auth = this.profile.auth;

    switch (auth.type) {
      case 'password':
        config.password = auth.password;
        config.tryKeyboard = true;
        this.logger.info(`Auth: password method${auth.password ? ' (password set + tryKeyboard)' : ' (no password provided!)'}`);
        break;
      case 'privateKey': {
        let keyData: Buffer | undefined;
        let hasCert = false;
        let keyFormat = 'unknown';

        if (auth.privateKey) {
          keyData = Buffer.from(auth.privateKey);
          this.logger.info('Auth: using inline privateKey');
        } else if (auth.privateKeyPath) {
          try {
            keyData = fs.readFileSync(auth.privateKeyPath);
            this.logger.info(`Auth: read privateKey from ${auth.privateKeyPath} (${keyData.length} bytes)`);

            // Check for SSH certificate (<key>-cert.pub) for CA-based authentication
            const certPaths: string[] = [];
            // Derive certificate path by appending -cert.pub
            certPaths.push(auth.privateKeyPath + '-cert.pub');
            // Derive certificate path by replacing extension (only if key has an extension)
            const keyWithExt = auth.privateKeyPath.replace(/\.[^/.]+$/, '-cert.pub');
            if (keyWithExt !== auth.privateKeyPath && !certPaths.includes(keyWithExt)) {
              certPaths.push(keyWithExt);
            }

            for (const certPath of certPaths) {
              const normalizedCertPath = path.normalize(certPath);
              if (fs.existsSync(normalizedCertPath)) {
                hasCert = true;
                this.logger.info(`Auth: SSH certificate detected at ${normalizedCertPath}`);
                break;
              }
            }
          } catch (e: any) {
            this.logger.error(`Auth: failed to read privateKey from ${auth.privateKeyPath}: ${e.message}`);
          }
        } else {
          // No key configured: search for default SSH keys (~/.ssh/id_ed25519, id_rsa, etc.)
          const defaultKeyPath = this.findDefaultKey();
          if (defaultKeyPath) {
            try {
              keyData = fs.readFileSync(defaultKeyPath);
              this.logger.info(`Auth: no key configured, using default key: ${defaultKeyPath} (${keyData.length} bytes)`);

              // Check for cert on default key too
              const sshDir = path.join(os.homedir(), '.ssh');
              const baseName = path.basename(defaultKeyPath);
              const certPath = path.join(sshDir, baseName + '-cert.pub');
              if (fs.existsSync(certPath)) {
                hasCert = true;
                this.logger.info(`Auth: SSH certificate detected for default key at ${certPath}`);
              }
            } catch (e: any) {
              this.logger.warn(`Auth: failed to read default key ${defaultKeyPath}: ${e.message}`);
            }
          } else {
            this.logger.warn('Auth: privateKey type selected but no key provided and no default keys found');
          }
        }

        // If a certificate is detected and SSH agent is available, use agent
        // (ssh-agent automatically associates -cert.pub files with their keys)
        if (hasCert && process.env.SSH_AUTH_SOCK) {
          config.agent = process.env.SSH_AUTH_SOCK;
          config.tryKeyboard = true;
          this.logger.info(`Auth: certificate detected, using SSH agent for cert-based authentication`);
          break;
        } else if (hasCert && !process.env.SSH_AUTH_SOCK) {
          this.logger.warn('Auth: certificate detected but SSH_AUTH_SOCK not set — add key to ssh-agent first: ssh-add <key-path>');
        }

        // No cert or no agent: fall through to standard private key auth
        if (keyData) {
          config.privateKey = keyData;
        }

        // Detect key format for diagnostics
        if (keyData) {
          const header = keyData.toString('utf-8', 0, Math.min(50, keyData.length));
          if (header.includes('BEGIN OPENSSH PRIVATE KEY')) {
            keyFormat = 'OpenSSH';
          } else if (header.includes('BEGIN RSA PRIVATE KEY')) {
            keyFormat = 'PEM-RSA';
          } else if (header.includes('BEGIN EC PRIVATE KEY')) {
            keyFormat = 'PEM-EC';
          } else if (header.includes('BEGIN PRIVATE KEY')) {
            keyFormat = 'PKCS8';
          } else if (header.includes('BEGIN DSA PRIVATE KEY')) {
            keyFormat = 'PEM-DSA';
          }
          this.logger.info(`Auth: key format detected: ${keyFormat}`);
        }

        if (auth.passphrase) {
          config.passphrase = auth.passphrase;
          this.logger.info('Auth: passphrase provided');
          // Validate that the passphrase can actually decrypt the key
          if (keyData) {
            const parseResult = ssh2Utils.parseKey(keyData, auth.passphrase);
            if (parseResult instanceof Error) {
              this.logger.error(`Auth: passphrase validation failed — cannot decrypt key: ${parseResult.message}`);
            } else {
              this.logger.info('Auth: passphrase successfully decrypts the key');
            }
          }
        } else if (keyData && this.isKeyEncrypted(keyData)) {
          // Encrypted key without passphrase: fall back to SSH agent
          if (process.env.SSH_AUTH_SOCK) {
            delete config.privateKey;
            config.agent = process.env.SSH_AUTH_SOCK;
            this.logger.info('Auth: encrypted key without passphrase, switched to SSH agent');
          } else {
            this.logger.warn('Auth: encrypted key without passphrase, but SSH agent not available — auth may fail');
          }
        } else if (!hasCert && process.env.SSH_AUTH_SOCK) {
          // Unencrypted key with SSH agent available: use both for authentication
          // Skip for cert keys — the cert is already embedded in the key
          config.agent = process.env.SSH_AUTH_SOCK;
          this.logger.info('Auth: unencrypted key + SSH agent both configured');
        } else {
          this.logger.info('Auth: unencrypted key only (no SSH agent available)');
        }

        // Always add tryKeyboard as a fallback so the server can prompt for password if key/agent fails
        config.tryKeyboard = true;
        this.logger.info(`Auth: key authentication configured (format: ${keyFormat}, hasCert: ${hasCert}, encrypted: ${keyData ? this.isKeyEncrypted(keyData) : 'N/A'}, tryKeyboard: true)`);
        break;
      }
      case 'agent': {
        const agentPath = auth.agent || process.env.SSH_AUTH_SOCK;
        config.agent = agentPath;
        config.tryKeyboard = true;
        this.logger.info(`Auth: agent method (agent=${agentPath || 'not set'}) + tryKeyboard fallback`);
        break;
      }
      case 'keyboard-interactive':
        config.tryKeyboard = true;
        this.logger.info('Auth: keyboard-interactive configured (tryKeyboard=true)');
        break;
    }
  }
}
