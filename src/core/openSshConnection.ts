import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RemoteFileInfo, TransferProgress } from './connection';
import { ConnectionStatus, ConnectionProfile } from './protocol';
import { buildSshArgs, toCliArgs, toScpArgs } from './openSshArgs';
import { profileHasCertificate } from './backendSelector';

import { Logger } from '../utils/logger';

export interface OpenSshRemoteConnection {
  status: ConnectionStatus;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listFiles(remotePath: string): Promise<RemoteFileInfo[]>;
  stat(remotePath: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number; mtime: number }>;
  readFile(remotePath: string): Promise<Buffer>;
  writeFile(remotePath: string, content: Buffer): Promise<void>;
  createDirectory(remotePath: string): Promise<void>;
  deleteFile(remotePath: string): Promise<void>;
  deleteDirectory(remotePath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  checkExists(remotePath: string): Promise<boolean>;
  downloadFile(remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<void>;
  uploadFile(localPath: string, remotePath: string, onProgress?: (progress: TransferProgress) => void): Promise<void>;
  uploadDirectory(localDir: string, remoteDir: string, onProgress?: (progress: TransferProgress) => void): Promise<void>;
  setstat(remotePath: string, attrs: { mode?: number }): Promise<void>;
  getProfile(): ConnectionProfile;
}

export class OpenSshConnection implements OpenSshRemoteConnection {
  status: ConnectionStatus = ConnectionStatus.Disconnected;
  private profile: ConnectionProfile;
  private logger: Logger;

  onStatusChange: ((status: ConnectionStatus) => void) | null = null;
  onDisconnected: (() => void) | null = null;

  constructor(profile: ConnectionProfile, logger: Logger) {
    this.profile = profile;
    this.logger = logger;
  }

  getProfile(): ConnectionProfile {
    return this.profile;
  }

  async connect(): Promise<void> {
    this.status = ConnectionStatus.Connecting;
    this.onStatusChange?.(ConnectionStatus.Connecting);

    try {
      // Test connection with a simple command
      const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
      const args = [...toCliArgs(sshArgs), 'echo connected'];
      const result = await this.runCommand(args);

      if (result.stdout.trim() === 'connected') {
        this.status = ConnectionStatus.Connected;
        this.onStatusChange?.(ConnectionStatus.Connected);
        this.logger.info(`OpenSSH connected to ${this.profile.name} (${this.profile.host}:${this.profile.port})`);
      } else {
        throw new Error(`Unexpected response: ${result.stdout}`);
      }
    } catch (err) {
      this.status = ConnectionStatus.Error;
      this.onStatusChange?.(ConnectionStatus.Error);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`OpenSSH connection failed for ${this.profile.name}: ${message}`);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.status = ConnectionStatus.Disconnected;
    this.onStatusChange?.(ConnectionStatus.Disconnected);
    this.onDisconnected?.();
  }

  private getCertificatePath(): string | undefined {
    return profileHasCertificate(this.profile, fs.existsSync) || undefined;
  }

  private async runCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`ssh exited with code ${code}: ${stderr}`));
      });
      proc.on('error', reject);
    });
  }

  async listFiles(remotePath: string): Promise<RemoteFileInfo[]> {
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    // Use find + stat for reliable output across locales (avoids ls format issues)
    const cmd = `find "${remotePath}" -maxdepth 1 -mindepth 1 | while read -r f; do stat -c '%n|%F|%s|%Y|%a' "\$f" 2>/dev/null || stat -f '%N|%HT|%z|%m|%Lp' "\$f" 2>/dev/null; done`;
    const { stdout } = await this.runCommand([...toCliArgs(sshArgs), cmd]);
    return parseStatOutput(stdout);
  }

  async stat(remotePath: string): Promise<{
    isDirectory: boolean;
    isFile: boolean;
    size: number;
    mtime: number;
  }> {
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const cmd = `stat -c '%F|%s|%Y' "${remotePath}"`;
    const { stdout } = await this.runCommand([...toCliArgs(sshArgs), cmd]);
    const [type, sizeStr, mtimeStr] = stdout.trim().split('|');
    return {
      isDirectory: type.includes('directory'),
      isFile: type.includes('regular'),
      size: parseInt(sizeStr, 10),
      mtime: parseInt(mtimeStr, 10),
    };
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const tmpFile = path.join(os.tmpdir(), `ssh-${Date.now()}-${path.basename(remotePath)}`);
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const scpArgs = [...toScpArgs(sshArgs), `${this.profile.username}@${this.profile.host}:${remotePath}`, tmpFile];

    return new Promise((resolve, reject) => {
      const proc = spawn('scp', scpArgs, { stdio: 'pipe' });
      proc.on('close', (code) => {
        if (code === 0) {
          const content = fs.readFileSync(tmpFile);
          fs.unlinkSync(tmpFile);
          resolve(content);
        } else {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
          reject(new Error(`scp download failed with code ${code}`));
        }
      });
      proc.on('error', reject);
    });
  }

  async writeFile(remotePath: string, content: Buffer): Promise<void> {
    const tmpFile = path.join(os.tmpdir(), `ssh-${Date.now()}-${path.basename(remotePath)}`);
    fs.writeFileSync(tmpFile, content);

    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const scpArgs = [...toScpArgs(sshArgs), tmpFile, `${this.profile.username}@${this.profile.host}:${remotePath}`];

    return new Promise((resolve, reject) => {
      const proc = spawn('scp', scpArgs, { stdio: 'pipe' });
      proc.on('close', (code) => {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        if (code === 0) resolve();
        else reject(new Error(`scp upload failed with code ${code}`));
      });
      proc.on('error', (err) => {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        reject(err);
      });
    });
  }

  async createDirectory(remotePath: string): Promise<void> {
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const cmd = `mkdir -p "${remotePath}"`;
    await this.runCommand([...toCliArgs(sshArgs), cmd]);
  }

  async deleteFile(remotePath: string): Promise<void> {
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const cmd = `rm "${remotePath}"`;
    await this.runCommand([...toCliArgs(sshArgs), cmd]);
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const cmd = `rm -rf "${remotePath}"`;
    await this.runCommand([...toCliArgs(sshArgs), cmd]);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const cmd = `mv "${oldPath}" "${newPath}"`;
    await this.runCommand([...toCliArgs(sshArgs), cmd]);
  }

  async checkExists(remotePath: string): Promise<boolean> {
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const cmd = `test -e "${remotePath}"`;
    try {
      await this.runCommand([...toCliArgs(sshArgs), cmd]);
      return true;
    } catch {
      return false;
    }
  }

  async downloadFile(remotePath: string, localPath: string, _onProgress?: (progress: TransferProgress) => void): Promise<void> {
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const scpArgs = [...toScpArgs(sshArgs), `${this.profile.username}@${this.profile.host}:${remotePath}`, localPath];
    return new Promise((resolve, reject) => {
      const proc = spawn('scp', scpArgs, { stdio: 'pipe' });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`scp download failed with code ${code}`));
      });
      proc.on('error', reject);
    });
  }

  async uploadFile(localPath: string, remotePath: string, _onProgress?: (progress: TransferProgress) => void): Promise<void> {
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const scpArgs = [...toScpArgs(sshArgs), localPath, `${this.profile.username}@${this.profile.host}:${remotePath}`];
    return new Promise((resolve, reject) => {
      const proc = spawn('scp', scpArgs, { stdio: 'pipe' });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`scp upload failed with code ${code}`));
      });
      proc.on('error', reject);
    });
  }

  async uploadDirectory(localDir: string, remoteDir: string, _onProgress?: (progress: TransferProgress) => void): Promise<void> {
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const scpArgs = [...toScpArgs(sshArgs), localDir, `${this.profile.username}@${this.profile.host}:${remoteDir}`];
    return new Promise((resolve, reject) => {
      const proc = spawn('scp', scpArgs, { stdio: 'pipe' });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`scp directory upload failed with code ${code}`));
      });
      proc.on('error', reject);
    });
  }

  async setstat(remotePath: string, attrs: { mode?: number }): Promise<void> {
    if (attrs.mode === undefined) return;
    const sshArgs = buildSshArgs(this.profile, { certificateFile: this.getCertificatePath() });
    const cmd = `chmod ${attrs.mode.toString(8).padStart(4, '0')} "${remotePath}"`;
    await this.runCommand([...toCliArgs(sshArgs), cmd]);
  }
}

function parseStatOutput(output: string): RemoteFileInfo[] {
  const lines = output.trim().split('\n');
  const files: RemoteFileInfo[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split('|');
    if (parts.length < 5) continue;

    const fullPath = parts[0];
    const type = parts[1];
    const size = parseInt(parts[2], 10);
    const mtime = parseInt(parts[3], 10);
    const mode = parseInt(parts[4], 8);

    const name = path.basename(fullPath);
    if (!name || name === '.' || name === '..') continue;

    const isDir = type.includes('directory') || type.includes('dossier') || type.includes('Verzeichnis');
    const isFile = type.includes('regular') || type.includes('file') || type.includes('reguläre');

    files.push({
      name,
      isDirectory: isDir,
      isFile,
      size,
      modifyTime: mtime * 1000, // convert unix timestamp to ms
      accessTime: mtime * 1000,
      longname: `${isDir ? 'd' : '-'}${mode.toString(8).padStart(4, '0')} ${size} ${name}`,
      mode,
    });
  }

  return files;
}
