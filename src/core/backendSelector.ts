import * as path from 'path';
import * as os from 'os';

export function getCertificateCandidates(privateKeyPath?: string): string[] {
  const candidates: string[] = [];

  if (privateKeyPath) {
    const resolved = privateKeyPath.startsWith('~')
      ? path.join(os.homedir(), privateKeyPath.slice(1))
      : privateKeyPath;

    // Replace common extensions with -cert.pub
    for (const ext of ['.pub', '.pem', '.key', '']) {
      if (ext === '' || resolved.endsWith(ext)) {
        const base = ext ? resolved.slice(0, -ext.length) : resolved;
        candidates.push(`${base}-cert.pub`);
      }
    }
  }

  return [...new Set(candidates)];
}

export function profileHasCertificate(
  profile: { auth?: { type?: string; privateKeyPath?: string; certificatePath?: string } },
  exists: (p: string) => boolean,
): string | null {
  if (profile.auth?.type === 'privateKey' || profile.auth?.type === 'certificate') {
    // 1. 检查显式配置的 certificatePath
    if (profile.auth.certificatePath) {
      const resolved = profile.auth.certificatePath.startsWith('~')
        ? path.join(os.homedir(), profile.auth.certificatePath.slice(1))
        : profile.auth.certificatePath;
      if (exists(resolved)) {
        return resolved;
      }
    }

    // 2. 从私钥路径推导证书路径（替换后缀为 -cert.pub）
    const candidates = getCertificateCandidates(profile.auth.privateKeyPath);
    for (const candidate of candidates) {
      if (exists(candidate)) {
        return candidate;
      }
    }

    // 3. 检查默认密钥的证书
    const sshDir = path.join(os.homedir(), '.ssh');
    for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
      const certPath = path.join(sshDir, `${name}-cert.pub`);
      if (exists(certPath)) {
        return certPath;
      }
    }
  }
  return null;
}

export function selectConnectionBackend(
  profile: { auth?: { type?: string; privateKeyPath?: string; certificatePath?: string }; backend?: string },
  exists: (p: string) => boolean,
): 'ssh2' | 'openssh' {
  if (profile.backend === 'ssh2') return 'ssh2';
  if (profile.backend === 'openssh') return 'openssh';

  // Auto: detect certificate — use openssh for cert-based auth, ssh2 for everything else
  if (profileHasCertificate(profile, exists)) {
    return 'openssh';
  }

  return 'ssh2';
}
