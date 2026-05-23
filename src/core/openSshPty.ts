import * as vscode from 'vscode';
import { ConnectionProfile } from './protocol';
import { buildSshArgs, toCliArgs } from './openSshArgs';
import * as fs from 'fs';
import { profileHasCertificate } from './backendSelector';
import { spawn, ChildProcess } from 'child_process';

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

  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  constructor(private profile: ConnectionProfile) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    const cols = initialDimensions?.columns || 80;
    const rows = initialDimensions?.rows || 24;

    const sshArgs = buildSshArgs(this.profile, {
      certificateFile: profileHasCertificate(this.profile, fs.existsSync) || undefined,
    });

    const args = [
      ...toCliArgs(sshArgs),
      '-t',
      '-o', `Columns=${cols}`,
      '-o', `Rows=${rows}`,
    ];

    this.process = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const proc = this.process;
    proc.stdout?.on('data', (data: Buffer) => {
      this.writeEmitter.fire(data.toString());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      this.writeEmitter.fire(data.toString());
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
}
