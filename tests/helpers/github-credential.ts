import { authStore } from '../../src/auth/auth-store';
import { encrypt } from '../../src/auth/crypto';

/** Install synthetic encrypted credentials without exercising unrelated HTTP token probes. */
export async function installGitHubCredential(token = 'github_pat_synthetic', username = 'octocat') {
  const { cipher, meta } = await encrypt(token);
  await authStore.update({
    tokenEncrypted: cipher,
    tokenCryptoMeta: meta,
    githubCredentialStatus: 'ready',
    username,
  });
  await authStore.getGitHubCredentialSnapshot();
}
