export function normalizeRemotePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

export function joinRemotePath(...parts: string[]): string {
  const joined = parts.map(p => p.replace(/\\/g, '/')).join('/');
  return normalizeRemotePath(joined);
}

export function getFileName(path: string): string {
  const normalized = normalizeRemotePath(path);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

export function getDirectoryName(path: string): string {
  const normalized = normalizeRemotePath(path);
  const parts = normalized.split('/');
  parts.pop();
  return parts.join('/') || '/';
}

export function isSubPath(parent: string, child: string): boolean {
  const normalizedParent = normalizeRemotePath(parent);
  const normalizedChild = normalizeRemotePath(child);
  return normalizedChild.startsWith(normalizedParent + '/') || normalizedChild === normalizedParent;
}
