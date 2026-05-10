import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SSHConfig, { Line, LineType, Directive } from 'ssh-config';
import { ConnectionProfile, Protocol, AuthConfig } from './protocol';
import { Logger } from '../utils/logger';

export class SshConfigParserImpl {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  parseFile(filePath: string): ConnectionProfile[] {
    const resolvedPath = this.resolvePath(filePath);
    this.logger.info(`Parsing SSH config: ${resolvedPath}`);

    if (!fs.existsSync(resolvedPath)) {
      this.logger.warn(`SSH config file not found: ${resolvedPath}`);
      return [];
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    return this.parse(content, resolvedPath);
  }

  parse(content: string, configFilePath?: string): ConnectionProfile[] {
    const config = SSHConfig.parse(content);
    const profiles: ConnectionProfile[] = [];

    this.processLines(config, profiles, configFilePath);
    this.logger.info(`Parsed ${profiles.length} connection profiles from config`);
    return profiles;
  }

  private processLines(
    lines: SSHConfig,
    profiles: ConnectionProfile[],
    configFilePath?: string,
  ): void {
    for (const line of lines) {
      if (line.type !== LineType.DIRECTIVE) continue;

      const directive = line as Directive;
      if (directive.param.toLowerCase() === 'host') {
        const hostNames = this.getDirectiveValue(directive).split(/\s+/);
        for (const hostName of hostNames) {
          if (hostName === '*' || hostName === '!' || hostName.startsWith('!')) continue;
          const options = this.collectOptions(line);
          profiles.push(this.buildProfile(hostName, options, configFilePath));
        }
      }

      if (directive.param.toLowerCase() === 'include' && configFilePath) {
        this.processInclude(this.getDirectiveValue(directive), profiles, path.dirname(configFilePath));
      }
    }
  }

  private collectOptions(line: Line): Record<string, string> {
    const options: Record<string, string> = {};
    if ('config' in line && line.config) {
      for (const child of line.config) {
        if (child.type === LineType.DIRECTIVE) {
          const d = child as Directive;
          options[d.param.toLowerCase()] = this.getDirectiveValue(d);
        }
      }
    }
    return options;
  }

  private getDirectiveValue(directive: Directive): string {
    if (typeof directive.value === 'string') {
      return directive.value;
    }
    return directive.value.map(v => (typeof v === 'string' ? v : v.val)).join(' ');
  }

  private processInclude(
    pattern: string,
    profiles: ConnectionProfile[],
    baseDir: string,
  ): void {
    const resolvedPattern = this.resolvePath(pattern, baseDir);

    let matchedFiles: string[] = [];
    if (pattern.includes('*') || pattern.includes('?')) {
      const dir = path.dirname(resolvedPattern);
      const glob = path.basename(resolvedPattern);
      if (fs.existsSync(dir)) {
        matchedFiles = fs.readdirSync(dir)
          .filter(f => this.matchGlob(f, glob))
          .map(f => path.join(dir, f));
      }
    } else {
      if (fs.existsSync(resolvedPattern)) {
        matchedFiles = [resolvedPattern];
      }
    }

    for (const file of matchedFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      this.parse(content, file).forEach(p => profiles.push(p));
    }
  }

  private buildProfile(
    host: string,
    options: Record<string, string>,
    configFilePath?: string,
  ): ConnectionProfile {
    const hostname = options.hostname || host;
    const user = options.user || os.userInfo().username;
    const port = parseInt(options.port || '22', 10);

    const auth: AuthConfig = this.buildAuth(options);

    return {
      id: `ssh-config-${host}`,
      name: host,
      host: hostname,
      port,
      username: user,
      protocol: Protocol.SFTP,
      auth,
      remotePath: options.remotepath,
      connectTimeout: options.connecttimeout ? parseInt(options.connecttimeout, 10) : 10000,
      source: 'config-file',
      configFilePath,
    };
  }

  private buildAuth(options: Record<string, string>): AuthConfig {
    if (options.identityfile) {
      return {
        type: 'privateKey',
        privateKeyPath: this.resolvePath(this.getDirectiveValue({ param: '', value: options.identityfile, type: LineType.DIRECTIVE } as Directive)),
        passphrase: options.passphrase,
      };
    }

    if (options.identityagent) {
      return {
        type: 'agent',
        agent: options.identityagent,
      };
    }

    return {
      type: 'privateKey',
    };
  }

  private resolvePath(p: string, baseDir?: string): string {
    if (p.startsWith('~')) {
      return path.join(os.homedir(), p.slice(1));
    }
    if (path.isAbsolute(p)) {
      return p;
    }
    if (baseDir) {
      return path.join(baseDir, p);
    }
    return p;
  }

  private matchGlob(filename: string, pattern: string): boolean {
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return regex.test(filename);
  }
}
