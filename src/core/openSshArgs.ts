import * as path from 'path';
import * as os from 'os';
import { ConnectionProfile } from './protocol';

export interface SshArgs {
  host: string;
  port: number;
  username: string;
  identityFile?: string;
  certificateFile?: string;
  extraOptions?: string[];
}

export function resolveIdentityPath(privateKeyPath?: string): string | undefined {
  if (!privateKeyPath) return undefined;
  if (privateKeyPath.startsWith('~')) {
    return path.join(os.homedir(), privateKeyPath.slice(1));
  }
  return privateKeyPath;
}

export function resolveCertificatePath(privateKeyPath?: string): string | undefined {
  const identityPath = resolveIdentityPath(privateKeyPath);
  if (!identityPath) return undefined;
  return `${identityPath}-cert.pub`;
}

export function buildSshArgs(
  profile: ConnectionProfile,
  options?: { certificateFile?: string },
): SshArgs {
  const args: SshArgs = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
  };

  if (profile.auth?.type === 'privateKey' && profile.auth.privateKeyPath) {
    args.identityFile = resolveIdentityPath(profile.auth.privateKeyPath);
  }

  if (options?.certificateFile) {
    args.certificateFile = options.certificateFile;
  } else if (profile.auth?.type === 'privateKey' && profile.auth.privateKeyPath) {
    args.certificateFile = resolveCertificatePath(profile.auth.privateKeyPath);
  }

  args.extraOptions = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=no',
  ];

  return args;
}

export function toCliArgs(args: SshArgs): string[] {
  const cli: string[] = [];

  cli.push('-F', '/dev/null'); // Skip user config to avoid syntax errors
  cli.push('-p', String(args.port));

  if (args.identityFile) {
    cli.push('-i', args.identityFile);
  }

  if (args.certificateFile) {
    cli.push('-o', `CertificateFile=${args.certificateFile}`);
  }

  if (args.extraOptions) {
    cli.push(...args.extraOptions);
  }

  cli.push(`${args.username}@${args.host}`);
  return cli;
}

export function toScpArgs(args: SshArgs): string[] {
  const cli: string[] = [];

  cli.push('-F', '/dev/null'); // Skip user config to avoid syntax errors
  cli.push('-P', String(args.port));
  cli.push('-r');

  if (args.identityFile) {
    cli.push('-i', args.identityFile);
  }

  if (args.certificateFile) {
    cli.push('-o', `CertificateFile=${args.certificateFile}`);
  }

  if (args.extraOptions) {
    cli.push(...args.extraOptions);
  }

  return cli;
}
