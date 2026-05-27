import assert from 'assert';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { createPasswordAskpass, quoteShellString } from '../../src/terminal/passwordAskpass';

suite('Password askpass', () => {
  test('quotes single quotes for shell scripts', () => {
    assert.strictEqual(quoteShellString("pa'ss"), "'pa'\\''ss'");
  });

  test('creates an executable askpass script that prints the password', () => {
    const askpass = createPasswordAskpass("pa'ss");

    try {
      const output = execFileSync(askpass.scriptPath, { encoding: 'utf8' });

      assert.strictEqual(output, "pa'ss\n");
      assert.strictEqual(askpass.env.SSH_ASKPASS, askpass.scriptPath);
      assert.strictEqual(askpass.env.SSH_ASKPASS_REQUIRE, 'force');
    } finally {
      askpass.cleanup();
    }

    assert.ok(!fs.existsSync(askpass.scriptPath));
  });
});
