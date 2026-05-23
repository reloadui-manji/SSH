import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { buildOpenSshPtyOptions } from '../../src/core/openSshPty';
import { ConnectionProfile, Protocol } from '../../src/core/protocol';

function profile(): ConnectionProfile {
  return {
    id: 'cert',
    name: 'cert',
    host: 'example.com',
    port: 10099,
    username: 'root',
    protocol: Protocol.SFTP,
    auth: {
      type: 'privateKey',
      privateKeyPath: '~/.ssh/id_ed25519',
      certificatePath: '~/.ssh/id_ed25519-cert.pub',
    },
    backend: 'openssh',
    connectTimeout: 15000,
    source: 'manual',
  };
}

suite('OpenSSH PTY', () => {
  test('builds ssh arguments with identity, certificate, and terminal size', () => {
    const options = buildOpenSshPtyOptions(profile(), { columns: 132, rows: 43 });

    assert.strictEqual(options.file, 'ssh');
    assert.deepStrictEqual(options.size, { cols: 132, rows: 43 });
    assert.ok(options.args.includes('-tt'));
    assert.ok(options.args.includes('example.com'));
    assert.ok(options.args.includes(path.join(os.homedir(), '.ssh/id_ed25519')));
    assert.ok(options.args.includes(`CertificateFile=${path.join(os.homedir(), '.ssh/id_ed25519-cert.pub')}`));
  });

  test('does not read the default ssh config for manual connections', () => {
    const options = buildOpenSshPtyOptions(profile(), { columns: 80, rows: 24 });

    assert.deepStrictEqual(options.args.slice(1, 3), ['-F', '/dev/null']);
  });

  test('does not pass the private key path as CertificateFile', () => {
    const p = profile();
    p.auth = {
      type: 'privateKey',
      privateKeyPath: '/tmp/id_ed25519',
      certificatePath: '/tmp/id_ed25519',
    };

    const options = buildOpenSshPtyOptions(p, { columns: 80, rows: 24 });

    assert.ok(!options.args.includes('CertificateFile=/tmp/id_ed25519'));
  });
});
