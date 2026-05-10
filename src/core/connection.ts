import { Client, SFTPWrapper, Channel } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionProfile, ConnectionStatus, Protocol } from './protocol';
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

export class SshConnection {
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
        resolve();
      });

      this.client.once('error', (err) => {
        clearTimeout(timer);
        this.setStatus(ConnectionStatus.Error);
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
        reject(err);
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
      };

      this.applyAuth(connectConfig);
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

    await this.uploadDirectoryRecursive(localDir, remoteDir, reportProgress, () => { uploadedFiles++; });

    onProgress?.({ bytesTransferred: uploadedFiles, totalBytes: totalFiles, percent: 100 });
  }

  async uploadFile(localPath: string, remotePath: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
    const sftp = await this.getSftp();
    const stat = fs.statSync(localPath);

    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath);
      let bytesTransferred = 0;

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

      readStream.on('error', reject);
      writeStream.on('error', reject);
      let resolved = false;
      const complete = () => {
        if (resolved) return;
        resolved = true;
        try {
          onProgress?.({ bytesTransferred: stat.size, totalBytes: stat.size, percent: 100 });
        } catch {}
        resolve();
      };
      writeStream.on('close', complete);
      writeStream.on('finish', complete);
      readStream.on('end', () => writeStream.end());
      setTimeout(() => { if (!resolved) complete(); }, 10000);

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
    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
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

  async createShellStream(): Promise<Channel> {
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

  private applyAuth(config: Parameters<Client['connect']>[0]): void {
    const auth = this.profile.auth;

    switch (auth.type) {
      case 'password':
        config.password = auth.password;
        break;
      case 'privateKey':
        if (auth.privateKey) {
          config.privateKey = auth.privateKey;
        } else if (auth.privateKeyPath) {
          config.privateKey = fs.readFileSync(auth.privateKeyPath);
        }
        if (auth.passphrase) {
          config.passphrase = auth.passphrase;
        } else if (process.env.SSH_AUTH_SOCK) {
          // Encrypted key without passphrase: fall back to SSH agent
          config.agent = process.env.SSH_AUTH_SOCK;
          delete config.privateKey;
          delete config.passphrase;
          this.logger.info('Encrypted private key detected without passphrase, using SSH agent');
        }
        break;
      case 'agent':
        config.agent = auth.agent || process.env.SSH_AUTH_SOCK;
        break;
      case 'keyboard-interactive':
        break;
    }
  }
}
