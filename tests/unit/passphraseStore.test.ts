import assert from 'assert';
import { getSavedPassphrase, setSavedPassphrase } from '../../src/core/passphraseStore';

suite('passphrase store', () => {
  test('stores passphrases by normalized key path', () => {
    const store: Record<string, string> = {};

    setSavedPassphrase(store, '/tmp/../tmp/id_ed25519', 'secret');

    assert.strictEqual(getSavedPassphrase(store, '/tmp/id_ed25519'), 'secret');
  });
});
