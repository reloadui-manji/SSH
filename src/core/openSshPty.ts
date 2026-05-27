import * as vscode from 'vscode';
import { ConnectionProfile } from './protocol';
import { buildSshArgs, resolveIdentityPath, toCliArgs } from './openSshArgs';
import * as fs from 'fs';
import { profileHasCertificate } from './backendSelector';
import { spawn, ChildProcess } from 'child_process';

export interface OpenSshPtyOptions {
  file: 'ssh';
  args: string[];
  size: { cols: number; rows: number };
}

export function buildOpenSshPtyOptions(
  profile: ConnectionProfile,
  dimensions?: { columns: number; rows: number },
): OpenSshPtyOptions {
  const cols = dimensions?.columns || 80;
  const rows = dimensions?.rows || 24;
  const sshArgs = buildSshArgs(profile, {
    certificateFile: getTerminalCertificateFile(profile),
  });

  return {
    file: 'ssh',
    args: [
      '-tt',
      ...toCliArgs(sshArgs),
    ],
    size: { cols, rows },
  };
}

export function resolveTerminalPasswordResponse(profile: ConnectionProfile, output: string): string | undefined {
  if (profile.auth.type !== 'password' || !profile.auth.password) {
    return undefined;
  }

  if (!/(^|[\s'"])password:\s*$/im.test(output)) {
    return undefined;
  }

  return `${profile.auth.password}\n`;
}

export async function createOpenSshPty(
  profile: ConnectionProfile,
  _terminalDimensions?: { columns: number; rows: number },
): Promise<vscode.Pseudoterminal> {
  return new OpenSshPseudoterminal(profile);
}

class OpenSshPseudoterminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number>();
  private process: ChildProcess | null = null;
  private passwordSent = false;

  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  constructor(private profile: ConnectionProfile) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    const options = buildOpenSshPtyOptions(this.profile, initialDimensions);

    this.process = spawn(options.file, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const proc = this.process;
    proc.stdout?.on('data', (data: Buffer) => {
      this.handleOutput(data.toString());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      this.handleOutput(data.toString());
    });

    proc.on('close', (code: number) => {
      this.closeEmitter.fire(code ?? 1);
    });

    proc.on('error', (err: Error) => {
      this.writeEmitter.fire(`\r\nSSH Error: ${err.message}\r\n`);
      this.closeEmitter.fire(1);
    });
  }

  close(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  handleInput(data: string): void {
    if (this.process?.stdin) {
      this.process.stdin.write(data);
    }
  }

  private handleOutput(output: string): void {
    this.writeEmitter.fire(output);

    if (this.passwordSent || !this.process?.stdin) {
      return;
    }

    const response = resolveTerminalPasswordResponse(this.profile, output);
    if (response) {
      this.process.stdin.write(response);
      this.passwordSent = true;
    }
  }
}

function getTerminalCertificateFile(profile: ConnectionProfile): string | undefined {
  if (profile.auth.type === 'privateKey' && profile.auth.certificatePath) {
    const certificatePath = resolveIdentityPath(profile.auth.certificatePath);
    const identityPath = resolveIdentityPath(profile.auth.privateKeyPath);

    if (certificatePath && certificatePath !== identityPath) {
      return certificatePath;
    }
  }

  return profileHasCertificate(profile, fs.existsSync) || undefined;
}
