export interface SyncRule {
  include: string[];
  exclude: string[];
}

export interface SyncConfig {
  connectionId: string;
  remoteRoot: string;
  sync: {
    autoUploadOnSave: boolean;
    uploadOnSaveDebounceMs: number;
    include: string[];
    exclude: string[];
  };
}

export function parseSyncConfig(content: string): SyncConfig {
  const parsed = JSON.parse(content);
  return {
    connectionId: parsed.connectionId || '',
    remoteRoot: parsed.remoteRoot || '/',
    sync: {
      autoUploadOnSave: parsed.sync?.autoUploadOnSave ?? true,
      uploadOnSaveDebounceMs: parsed.sync?.uploadOnSaveDebounceMs ?? 500,
      include: parsed.sync?.include ?? ['**/*'],
      exclude: parsed.sync?.exclude ?? [],
    },
  };
}

export function matchesPatterns(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === '*' || pattern === '**/*') return true;
    if (pattern.startsWith('**/')) {
      const suffix = pattern.slice(3);
      if (filePath.endsWith(suffix)) return true;
    }
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1);
      if (filePath.endsWith(ext)) return true;
    }
    if (filePath.includes(pattern)) return true;
  }
  return false;
}

export function shouldSync(filePath: string, rules: SyncRule): boolean {
  if (rules.exclude.length > 0 && matchesPatterns(filePath, rules.exclude)) {
    return false;
  }
  if (rules.include.length === 0) return true;
  return matchesPatterns(filePath, rules.include);
}
