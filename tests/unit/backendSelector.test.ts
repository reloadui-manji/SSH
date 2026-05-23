import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { selectConnectionBackend } from '../../src/core/backendSelector';
import { ConnectionProfile, Protocol } from '../../src/core/protocol';

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'test',
    name: 'test',
    host: 'example.com',
    port: 22,
    username: 'root',
    protocol: Protocol.SFTP,
    auth: { type: 'privateKey', privateKeyPath: '/tmp/id_ed25519' },
    source: 'manual',
    ...overrides,
  };
}

suite('backend selector', () => {
  test('uses ssh2 by default when no certificate is present', () => {
    const selected = selectConnectionBackend(profile(), () => false);

    assert.strictEqual(selected, 'ssh2');
  });

  test('uses openssh automatically when a matching certificate file exists', () => {
    const selected = selectConnectionBackend(profile(), candidate => candidate === '/tmp/id_ed25519-cert.pub');

    assert.strictEqual(selected, 'openssh');
  });

  test('honors an explicit ssh2 backend override', () => {
    const selected = selectConnectionBackend(profile({ backend: 'ssh2' }), () => true);

    assert.strictEqual(selected, 'ssh2');
  });

  test('expands home paths before detecting matching certificate files', () => {
    const certPath = path.join(os.homedir(), '.ssh/id_ed25519-cert.pub');
    const selected = selectConnectionBackend(
      profile({ auth: { type: 'privateKey', privateKeyPath: '~/.ssh/id_ed25519' } }),
      candidate => candidate === certPath,
    );

    assert.strictEqual(selected, 'openssh');
  });
});
