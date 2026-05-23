import * as vscode from 'vscode';

export function getSavedPassphrase(keyPath: string): string | undefined {
  const config = vscode.workspace.getConfiguration('ssh');
  const passphrases: Record<string, string> = config.get('keyPassphrases', {});
  return passphrases[keyPath];
}

export function setSavedPassphrase(keyPath: string, passphrase: string): Thenable<void> {
  const config = vscode.workspace.getConfiguration('ssh');
  const passphrases: Record<string, string> = config.get('keyPassphrases', {});
  passphrases[keyPath] = passphrase;
  return config.update('keyPassphrases', passphrases, vscode.ConfigurationTarget.Global);
}

export function deleteSavedPassphrase(keyPath: string): Thenable<void> {
  const config = vscode.workspace.getConfiguration('ssh');
  const passphrases: Record<string, string> = config.get('keyPassphrases', {});
  delete passphrases[keyPath];
  return config.update('keyPassphrases', passphrases, vscode.ConfigurationTarget.Global);
}
