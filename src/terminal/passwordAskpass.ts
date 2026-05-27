import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface PasswordAskpass {
  env: Record<string, string>;
  cleanup: () => void;
  scriptPath: string;
}

export function createPasswordAskpass(password: string): PasswordAskpass {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-askpass-'));
  fs.chmodSync(directory, 0o700);

  const scriptPath = path.join(directory, 'askpass.sh');
  fs.writeFileSync(scriptPath, `#!/bin/sh\nprintf '%s\\n' ${quoteShellString(password)}\n`, { mode: 0o700 });

  return {
    env: {
      SSH_ASKPASS: scriptPath,
      SSH_ASKPASS_REQUIRE: 'force',
    },
    cleanup: () => {
      fs.rmSync(directory, { recursive: true, force: true });
    },
    scriptPath,
  };
}

export function quoteShellString(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
