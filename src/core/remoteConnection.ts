import { RemoteFileInfo, SshConnection, TransferProgress } from './connection';
import { ConnectionStatus, ConnectionProfile } from './protocol';

export { TransferProgress };

export interface RemoteConnection {
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
  setstat(remotePath: string, attrs: { mode?: number; uid?: number; gid?: number }): Promise<void>;
  getProfile(): ConnectionProfile;
}

export function wrapSshConnection(conn: SshConnection): RemoteConnection {
  return {
    status: conn.status,
    connect: () => conn.connect(),
    disconnect: () => conn.disconnect(),
    listFiles: (p: string) => conn.listFiles(p),
    stat: async (p: string) => {
      const info = await conn.stat(p);
      return { isDirectory: info.isDirectory, isFile: info.isFile, size: info.size, mtime: info.mtime };
    },
    readFile: (p: string) => conn.readFile(p),
    writeFile: (p: string, c: Buffer) => conn.writeFile(p, c),
    createDirectory: (p: string) => conn.createDirectory(p),
    deleteFile: (p: string) => conn.deleteFile(p),
    deleteDirectory: (p: string) => conn.deleteDirectory(p),
    rename: (a: string, b: string) => conn.rename(a, b),
    checkExists: (p: string) => conn.checkExists(p),
    downloadFile: (rp, lp, pr) => conn.downloadFile(rp, lp, pr),
    uploadFile: (lp, rp, pr) => conn.uploadFile(lp, rp, pr),
    uploadDirectory: (ld, rd, pr) => conn.uploadDirectory(ld, rd, pr),
    setstat: (p, attrs) => conn.setstat(p, attrs),
    getProfile: () => conn.getProfile(),
  };
}
