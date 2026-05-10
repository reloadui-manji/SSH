import * as chokidar from 'chokidar';
import { Logger } from '../utils/logger';

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly debounceMs: number,
    private readonly logger: Logger,
  ) {}

  watch(
    paths: string | string[],
    onFileChange: (filePath: string) => void,
    ignorePatterns?: string[],
  ): void {
    this.watcher = chokidar.watch(paths, {
      ignored: ignorePatterns || [],
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('change', (filePath) => {
      this.debounce(filePath, () => onFileChange(filePath));
    });

    this.watcher.on('add', (filePath) => {
      this.debounce(filePath, () => onFileChange(filePath));
    });

    this.logger.info(`File watcher started for ${Array.isArray(paths) ? paths.join(', ') : paths}`);
  }

  stop(): void {
    if (this.watcher) {
      for (const timer of this.debounceTimers.values()) {
        clearTimeout(timer);
      }
      this.debounceTimers.clear();
      this.watcher.close();
      this.watcher = null;
      this.logger.info('File watcher stopped');
    }
  }

  private debounce(filePath: string, callback: () => void): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(filePath, setTimeout(() => {
      this.debounceTimers.delete(filePath);
      callback();
    }, this.debounceMs));
  }

  dispose(): void {
    this.stop();
  }
}
