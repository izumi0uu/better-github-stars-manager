import type { Config } from "@/types";
import { encrypt, decrypt } from "./crypto";
import { TOKEN_EMPTY } from "@/api/errors";
import { probeTokenCapabilities } from "./token-probe";
import {
  normalizeOnboardingStage,
  stageMarksOnboardingSeen,
} from "@/onboarding/state";

/**
 * Owns the fine-grained PAT lifecycle.
 *
 * The options page collects a token, verifies the GitHub capabilities this
 * extension needs, captures account identity, and only then persists the token.
 * Plaintext stays in memory; the stored copy is AES-GCM encrypted in
 * `chrome.storage.local`.
 */

export const CONFIG_STORAGE_KEY = "gsm_config";

const DEFAULT_CONFIG: Config = {
  tokenEncrypted: null,
  tokenCryptoMeta: null,
  theme: "dark",
  locale: "en",
  defaultView: "table",
  lastSyncStarredAt: null,
  gistId: null,
  gistSyncCursor: null,
  username: null,
  avatarUrl: null,
  displayName: null,
  onboardingStage: "needs_token",
  seenOnboarding: false,
  seenTooltips: 0,
  langTagMigrationDone: false,
  lastSyncProgress: { phase: "idle", done: 0, total: null, message: "" },
};

let cache: Config | null = null;
let plaintextToken: string | null = null; // in-memory only

function withNormalizedOnboarding(config: Config): Config {
  const hasTokenHint = !!(plaintextToken || config.tokenEncrypted);
  const onboardingStage = normalizeOnboardingStage(
    config.onboardingStage,
    config.seenOnboarding,
    hasTokenHint,
  );
  return {
    ...config,
    onboardingStage,
    seenOnboarding: stageMarksOnboardingSeen(onboardingStage),
  };
}

async function read(): Promise<Config> {
  if (cache) return cache;
  const raw = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
  const stored = (raw[CONFIG_STORAGE_KEY] ?? {}) as Partial<Config>;
  cache = withNormalizedOnboarding({ ...DEFAULT_CONFIG, ...stored });
  return cache;
}

async function write(next: Config): Promise<void> {
  const normalized = withNormalizedOnboarding(next);
  cache = normalized;
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: normalized });
}

async function readDecryptedToken(): Promise<string | null> {
  if (plaintextToken) return plaintextToken;
  const c = await read();
  if (!c.tokenEncrypted || !c.tokenCryptoMeta) return null;
  plaintextToken = await decrypt(c.tokenEncrypted, c.tokenCryptoMeta);
  return plaintextToken;
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const change = changes[CONFIG_STORAGE_KEY];
    if (!change) return;

    const prev = cache;
    const stored = (change.newValue ?? {}) as Partial<Config>;
    cache = withNormalizedOnboarding({ ...DEFAULT_CONFIG, ...stored });

    const tokenChanged =
      prev?.tokenEncrypted !== cache.tokenEncrypted ||
      JSON.stringify(prev?.tokenCryptoMeta ?? null) !==
        JSON.stringify(cache.tokenCryptoMeta ?? null);
    if (tokenChanged) plaintextToken = null;
  });
}

export const authStore = {
  async getConfig(): Promise<Config> {
    return read();
  },

  async hasToken(): Promise<boolean> {
    return !!(await readDecryptedToken());
  },

  /** The decrypted token, or null. Held only in memory. */
  async getToken(): Promise<string | null> {
    return readDecryptedToken();
  },

  async getUsername(): Promise<string | null> {
    return (await read()).username;
  },

  /** Account identity + bound gist for the top bar. */
  async getAccount(): Promise<{
    username: string | null;
    avatarUrl: string | null;
    displayName: string | null;
    gistId: string | null;
  }> {
    const c = await read();
    return {
      username: c.username,
      avatarUrl: c.avatarUrl,
      displayName: c.displayName,
      gistId: c.gistId,
    };
  },

  async getTheme(): Promise<"dark" | "light"> {
    return (await read()).theme;
  },

  async getLocale(): Promise<"en" | "zh-CN"> {
    return (await read()).locale;
  },

  async setTheme(theme: "dark" | "light"): Promise<void> {
    await write({ ...(await read()), theme });
  },

  async setLocale(locale: "en" | "zh-CN"): Promise<void> {
    await write({ ...(await read()), locale });
  },

  /**
   * Verify the PAT has the permissions we need (probeTokenCapabilities), then
   * encrypt+persist. Failure throws an errors.ts code; the token is never
   * persisted on failure.
   */
  async setToken(token: string): Promise<{ username: string }> {
    const clean = token.trim();
    if (!clean) throw new Error(TOKEN_EMPTY);

    const { login, avatarUrl, displayName, scopesHeader } =
      await probeTokenCapabilities(clean);
    const classicOk =
      scopesHeader.includes("public_repo") && scopesHeader.includes("gist");
    if (scopesHeader && !classicOk)
      console.warn(
        "[gsm] classic-token scopes may be insufficient:",
        scopesHeader,
      );

    const { cipher, meta } = await encrypt(clean);
    plaintextToken = clean;
    const current = await read();
    const onboardingStage =
      current.onboardingStage === "done" ? "done" : "awaiting_sync";
    await write({
      ...current,
      tokenEncrypted: cipher,
      tokenCryptoMeta: meta,
      username: login,
      avatarUrl,
      displayName,
      onboardingStage,
    });
    return { username: login };
  },

  async clearToken(): Promise<void> {
    plaintextToken = null;
    const current = await read();
    const onboardingStage =
      current.onboardingStage === "done" ? "done" : "needs_token";
    await write({
      ...current,
      tokenEncrypted: null,
      tokenCryptoMeta: null,
      username: null,
      avatarUrl: null,
      displayName: null,
      onboardingStage,
    });
  },

  async update(patch: Partial<Config>): Promise<void> {
    await write({ ...(await read()), ...patch });
  },
};
