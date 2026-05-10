import * as vscode from 'vscode';

export const SCHEME = 'ssh';

export function createUri(connectionId: string, remotePath: string): vscode.Uri {
  const normalizedPath = remotePath.replace(/\\/g, '/');
  return vscode.Uri.parse(`${SCHEME}://${connectionId}${normalizedPath}`);
}

export function parseUri(uri: vscode.Uri): { connectionId: string; remotePath: string } {
  const connectionId = uri.authority;
  const remotePath = uri.path || '/';
  return { connectionId, remotePath };
}

export function isValidUri(uri: vscode.Uri): boolean {
  return uri.scheme === SCHEME && !!uri.authority;
}
