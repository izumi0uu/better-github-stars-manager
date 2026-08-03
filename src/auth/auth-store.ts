import type {
  AgentCustomProviderProtocol,
  AgentModelContextCapability,
  Config,
} from "@/types";
import { encrypt, decrypt } from "./crypto";
import { TOKEN_EMPTY } from "@/api/errors";
import { probeTokenCapabilities } from "./token-probe";
import {
  normalizeOnboardingStage,
  stageMarksOnboardingSeen,
} from "@/onboarding/state";
import {
  DEFAULT_AUTO_TAG_LIMIT,
  DEFAULT_LIBRARY_VIEW_PREFS,
  DEFAULT_MIN_TOPIC_REPO_COUNT,
  normalizeLibraryViewPrefs,
  normalizeAutoTagLimit,
  normalizeMaxTagsPerRepo,
  normalizeMinTopicRepoCount,
  normalizeStarsPanelDefaultEnabled,
} from "@/preferences";
import { normalizeBackfillMap } from "@/upgrades/backfill-state";
import {
  normalizeColumnLayoutMode,
  normalizeStoredColumnLayoutPreference,
} from "@/ui/column-layout";
import {
  isSavedAgentCredentialEligible,
  normalizeAgentModel,
  normalizeAgentProviderConfig,
  providerCapabilityFingerprintV1,
  resolveAgentModelContextCapability,
  resolveAgentProviderEndpoint,
} from "@/agent-harness/models";
import {
  createAgentDataDisclosureAcceptance,
  isDisclosureAcceptedFor,
  validateAgentDataDisclosureAcceptance,
  type AgentDataDisclosureAcceptance,
} from "@/bgsm-agent/disclosure";

/**
 * Owns the fine-grained PAT lifecycle.
 *
 * The options page collects a token, verifies the GitHub capabilities this
 * extension needs, captures account identity, and only then persists the token.
 * Plaintext stays in memory; the stored copy is AES-GCM encrypted in
 * `chrome.storage.local`.
 */

export const CONFIG_STORAGE_KEY = "gsm_config";

export type AgentProviderCredentialSnapshot = Readonly<{
  provider: Config["agentProvider"]["provider"];
  canonicalBaseUrl: string;
  canonicalOrigin: string;
  completionEndpoint: string;
  protocol: ReturnType<typeof resolveAgentProviderEndpoint>["profile"]["protocol"];
  model: string;
  profileIdentityVersion: string;
  savedCompletionEndpoint: string;
  savedProtocol: ReturnType<typeof resolveAgentProviderEndpoint>["profile"]["protocol"];
  savedProfileIdentityVersion: string;
  savedModel: string;
  savedDeclaredContextWindow: number | null;
  savedWorkingContextWindow: number | null;
  encryptedCredentialIdentity: string;
  credentialRevision: string;
  fingerprint: string;
  capabilityReady: boolean;
  contextCapability?: AgentModelContextCapability | null;
  workingContextWindow?: number | null;
  apiKey: string;
}>;

const DEFAULT_CONFIG: Config = {
  tokenEncrypted: null,
  tokenCryptoMeta: null,
  agentProvider: {
    provider: "openai",
    protocol: null,
    baseUrl: null,
    model: "gpt-5.4",
    declaredContextWindow: null,
    workingContextWindow: null,
    apiKeyEncrypted: null,
    apiKeyCryptoMeta: null,
    credentialScope: null,
    credentialRevision: null,
    capability: null,
  },
  agentDataDisclosureAcceptance: null,
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
  autoTagAgentPromptSeen: false,
  autoTagLimit: DEFAULT_AUTO_TAG_LIMIT,
  maxTagsPerRepo: DEFAULT_AUTO_TAG_LIMIT,
  minTopicRepoCount: DEFAULT_MIN_TOPIC_REPO_COUNT,
  libraryView: DEFAULT_LIBRARY_VIEW_PREFS,
  starsPanelDefaultEnabled: true,
  columnLayoutMode: "default",
  customColumnLayout: null,
  langTagMigrationDone: false,
  lastSyncProgress: { phase: "idle", done: 0, total: null, message: "" },
  backfills: {},
};

let cache: Config | null = null;
let plaintextToken: string | null = null; // in-memory only
let plaintextAgentApiKey: {
  cipher: string;
  cryptoMeta: string;
  revision: string;
  value: string;
} | null = null; // in-memory only

function mergeStoredConfig(stored: Partial<Config>): Config {
  const maxTagsPerRepo =
    stored.maxTagsPerRepo === undefined ? stored.autoTagLimit : stored.maxTagsPerRepo;
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    agentProvider: normalizeAgentProviderConfig({
      ...DEFAULT_CONFIG.agentProvider,
      ...stored.agentProvider,
    }),
    agentDataDisclosureAcceptance: normalizeAgentDataDisclosureAcceptance(
      stored.agentDataDisclosureAcceptance,
    ),
    autoTagAgentPromptSeen: stored.autoTagAgentPromptSeen === true,
    maxTagsPerRepo: maxTagsPerRepo ?? DEFAULT_CONFIG.maxTagsPerRepo,
  };
}

function withNormalizedConfig(config: Config): Config {
  const hasTokenHint = !!(plaintextToken || config.tokenEncrypted);
  const onboardingStage = normalizeOnboardingStage(
    config.onboardingStage,
    config.seenOnboarding,
    hasTokenHint,
  );
  return {
    ...config,
    agentProvider: normalizeAgentProviderConfig(config.agentProvider),
    agentDataDisclosureAcceptance: normalizeAgentDataDisclosureAcceptance(
      config.agentDataDisclosureAcceptance,
    ),
    autoTagLimit: normalizeAutoTagLimit(config.autoTagLimit),
    maxTagsPerRepo: normalizeMaxTagsPerRepo(
      config.maxTagsPerRepo,
      config.autoTagLimit,
    ),
    minTopicRepoCount: normalizeMinTopicRepoCount(config.minTopicRepoCount),
    libraryView: normalizeLibraryViewPrefs(config.libraryView),
    starsPanelDefaultEnabled: normalizeStarsPanelDefaultEnabled(
      config.starsPanelDefaultEnabled,
    ),
    columnLayoutMode: normalizeColumnLayoutMode(config.columnLayoutMode),
    customColumnLayout: normalizeStoredColumnLayoutPreference(
      config.customColumnLayout,
    ),
    backfills: normalizeBackfillMap(config.backfills),
    onboardingStage,
    seenOnboarding: stageMarksOnboardingSeen(onboardingStage),
  };
}

async function read(): Promise<Config> {
  if (cache) return cache;
  cache = await readStoredConfig();
  return cache;
}

async function readStoredConfig(): Promise<Config> {
  const raw = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
  const stored = (raw[CONFIG_STORAGE_KEY] ?? {}) as Partial<Config>;
  return withNormalizedConfig(mergeStoredConfig(stored));
}

async function write(next: Config): Promise<void> {
  const normalized = withNormalizedConfig(next);
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: normalized });
  cache = normalized;
}

async function readDecryptedToken(): Promise<string | null> {
  if (plaintextToken) return plaintextToken;
  const c = await read();
  if (!c.tokenEncrypted || !c.tokenCryptoMeta) return null;
  plaintextToken = await decrypt(c.tokenEncrypted, c.tokenCryptoMeta);
  return plaintextToken;
}

async function readDecryptedAgentApiKey(
  requested?: Pick<Config["agentProvider"], "provider" | "baseUrl">,
): Promise<string | null> {
  const c = await read();
  const target = requested ?? c.agentProvider;
  if (!isSavedAgentCredentialEligible(c.agentProvider, target)) {
    return null;
  }
  return decryptAgentApiKey(c.agentProvider);
}

async function decryptAgentApiKey(
  config: Config["agentProvider"],
): Promise<string | null> {
  const cipher = config.apiKeyEncrypted;
  const meta = config.apiKeyCryptoMeta;
  const revision = config.credentialRevision;
  if (!cipher || !meta || !revision) return null;
  const cryptoMeta = JSON.stringify(meta);
  if (
    plaintextAgentApiKey?.cipher === cipher &&
    plaintextAgentApiKey.cryptoMeta === cryptoMeta &&
    plaintextAgentApiKey.revision === revision
  ) return plaintextAgentApiKey.value;
  const value = await decrypt(
    cipher,
    meta,
  );
  if (!value) return null;
  plaintextAgentApiKey = { cipher, cryptoMeta, revision, value };
  return value;
}

function sameCredentialRecord(
  left: Config["agentProvider"],
  right: Config["agentProvider"],
): boolean {
  return left.apiKeyEncrypted === right.apiKeyEncrypted &&
    JSON.stringify(left.apiKeyCryptoMeta) === JSON.stringify(right.apiKeyCryptoMeta) &&
    left.credentialRevision === right.credentialRevision &&
    JSON.stringify(left.credentialScope) === JSON.stringify(right.credentialScope);
}

function encryptedCredentialIdentity(config: Config["agentProvider"]): string {
  return JSON.stringify([
    config.apiKeyEncrypted,
    config.apiKeyCryptoMeta,
    config.credentialScope,
    config.credentialRevision,
  ]);
}

function matchesProviderTarget(
  config: Config["agentProvider"],
  target: {
    provider: Config["agentProvider"]["provider"];
    protocol?: AgentCustomProviderProtocol | null;
    baseUrl: string | null;
    model: string;
    declaredContextWindow?: number | null;
    workingContextWindow?: number | null;
  },
): boolean {
  if (!isSavedAgentCredentialEligible(config, target)) return false;
  try {
    const configuredEndpoint = resolveAgentProviderEndpoint(
      config.provider,
      config.baseUrl,
      config.protocol,
    );
    const targetEndpoint = resolveAgentProviderEndpoint(
      target.provider,
      target.baseUrl,
      target.protocol,
    );
    return configuredEndpoint.completionEndpoint === targetEndpoint.completionEndpoint &&
      normalizeAgentModel(config.provider, config.model) ===
        normalizeAgentModel(target.provider, target.model) &&
      (config.declaredContextWindow ?? null) === (target.declaredContextWindow ?? null) &&
      (config.workingContextWindow ?? null) === (target.workingContextWindow ?? null);
  } catch {
    return false;
  }
}

function sameProviderConfiguration(
  left: Config["agentProvider"],
  right: Config["agentProvider"],
): boolean {
  try {
    return resolveAgentProviderEndpoint(
      left.provider,
      left.baseUrl,
      left.protocol,
    ).completionEndpoint === resolveAgentProviderEndpoint(
      right.provider,
      right.baseUrl,
      right.protocol,
    ).completionEndpoint &&
      normalizeAgentModel(left.provider, left.model) ===
        normalizeAgentModel(right.provider, right.model) &&
      (left.declaredContextWindow ?? null) === (right.declaredContextWindow ?? null) &&
      (left.workingContextWindow ?? null) === (right.workingContextWindow ?? null);
  } catch {
    return false;
  }
}

function createAgentCredentialRevision(): string {
  if (typeof crypto.randomUUID === "function") {
    return `cr:v1:${crypto.randomUUID()}`;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `cr:v1:${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const change = changes[CONFIG_STORAGE_KEY];
    if (!change) return;

    const prev = cache;
    const stored = (change.newValue ?? {}) as Partial<Config>;
    cache = withNormalizedConfig(mergeStoredConfig(stored));

    const tokenChanged =
      prev?.tokenEncrypted !== cache.tokenEncrypted ||
      JSON.stringify(prev?.tokenCryptoMeta ?? null) !==
        JSON.stringify(cache.tokenCryptoMeta ?? null);
    if (tokenChanged) plaintextToken = null;

    plaintextAgentApiKey = null;
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

  /** The decrypted Cubby API key, or null. Held only in memory. */
  async getAgentApiKey(): Promise<string | null> {
    return readDecryptedAgentApiKey();
  },

  async getEligibleAgentApiKey(requested: {
    provider: Config["agentProvider"]["provider"];
    baseUrl: string | null;
  }): Promise<string | null> {
    return readDecryptedAgentApiKey(requested);
  },

  async getAgentProviderCredentialSnapshot(requested?: {
    provider: Config["agentProvider"]["provider"];
    protocol?: AgentCustomProviderProtocol | null;
    baseUrl: string | null;
    model: string;
    declaredContextWindow?: number | null;
    workingContextWindow?: number | null;
  }): Promise<AgentProviderCredentialSnapshot | null> {
    const before = (await readStoredConfig()).agentProvider;
    const target = requested ?? before;
    if (!isSavedAgentCredentialEligible(before, target) || !before.credentialRevision) return null;
    const apiKey = await decryptAgentApiKey(before);
    if (!apiKey) return null;
    const endpoint = resolveAgentProviderEndpoint(
      target.provider,
      target.baseUrl,
      target.protocol,
    );
    const model = normalizeAgentModel(target.provider, target.model);
    const declaredContextWindow = requested?.declaredContextWindow === undefined
      ? before.declaredContextWindow ?? null
      : requested.declaredContextWindow;
    const workingContextWindow = requested?.workingContextWindow === undefined
      ? before.workingContextWindow ?? null
      : requested.workingContextWindow;
    const contextCapability = resolveAgentModelContextCapability({
      provider: endpoint.provider,
      model,
      declaredContextWindow,
    }) ?? null;
    const fingerprint = await providerCapabilityFingerprintV1({
      provider: endpoint.provider,
      protocol: target.protocol ?? null,
      baseUrl: endpoint.canonicalBaseUrl,
      model,
      credentialRevision: before.credentialRevision,
      declaredContextWindow,
      workingContextWindow,
    });
    const latest = (await readStoredConfig()).agentProvider;
    if (
      !sameCredentialRecord(before, latest) ||
      !sameProviderConfiguration(before, latest) ||
      !isSavedAgentCredentialEligible(latest, target)
    ) {
      return null;
    }
    const savedEndpoint = resolveAgentProviderEndpoint(
      before.provider,
      before.baseUrl,
      before.protocol,
    );
    return Object.freeze({
      provider: endpoint.provider,
      canonicalBaseUrl: endpoint.canonicalBaseUrl,
      canonicalOrigin: endpoint.canonicalOrigin,
      completionEndpoint: endpoint.completionEndpoint,
      protocol: endpoint.profile.protocol,
      model,
      profileIdentityVersion: endpoint.profile.identityVersion,
      savedCompletionEndpoint: savedEndpoint.completionEndpoint,
      savedProtocol: savedEndpoint.profile.protocol,
      savedProfileIdentityVersion: savedEndpoint.profile.identityVersion,
      savedModel: normalizeAgentModel(before.provider, before.model),
      savedDeclaredContextWindow: before.declaredContextWindow ?? null,
      savedWorkingContextWindow: before.workingContextWindow ?? null,
      encryptedCredentialIdentity: encryptedCredentialIdentity(before),
      credentialRevision: before.credentialRevision,
      fingerprint,
      capabilityReady: latest.capability?.fingerprint === fingerprint &&
        latest.capability.textChat === true &&
        latest.capability.namedToolRoundTrip === true &&
        latest.capability.contextCapability?.capabilityRevision ===
          contextCapability?.capabilityRevision,
      contextCapability,
      workingContextWindow,
      apiKey,
    });
  },

  async validateAgentProviderCredentialSnapshot(
    snapshot: AgentProviderCredentialSnapshot,
  ): Promise<boolean> {
    const latest = (await readStoredConfig()).agentProvider;
    if (
      latest.credentialRevision !== snapshot.credentialRevision ||
      encryptedCredentialIdentity(latest) !== snapshot.encryptedCredentialIdentity ||
      latest.apiKeyEncrypted === null ||
      latest.apiKeyCryptoMeta === null ||
      latest.credentialScope?.provider !== snapshot.provider ||
      latest.credentialScope.origin !== snapshot.canonicalOrigin
    ) return false;
    try {
      const savedEndpoint = resolveAgentProviderEndpoint(
        latest.provider,
        latest.baseUrl,
        latest.protocol,
      );
      if (
        savedEndpoint.completionEndpoint !== snapshot.savedCompletionEndpoint ||
        savedEndpoint.profile.protocol !== snapshot.savedProtocol ||
        savedEndpoint.profile.identityVersion !== snapshot.savedProfileIdentityVersion ||
        normalizeAgentModel(latest.provider, latest.model) !== snapshot.savedModel ||
        (latest.declaredContextWindow ?? null) !== snapshot.savedDeclaredContextWindow ||
        (latest.workingContextWindow ?? null) !== snapshot.savedWorkingContextWindow
      ) return false;
      if (snapshot.capabilityReady) {
        return latest.capability?.fingerprint === snapshot.fingerprint &&
          latest.capability.textChat === true &&
          latest.capability.namedToolRoundTrip === true &&
          latest.capability.contextCapability?.capabilityRevision ===
            snapshot.contextCapability?.capabilityRevision;
      }
      return true;
    } catch {
      return false;
    }
  },

  async getAgentProviderReadiness(requested?: {
    provider: Config["agentProvider"]["provider"];
    protocol?: AgentCustomProviderProtocol | null;
    baseUrl: string | null;
    model: string;
    declaredContextWindow?: number | null;
    workingContextWindow?: number | null;
  }): Promise<{
    config: Config["agentProvider"];
    credentialEligible: boolean;
    capabilityReady: boolean;
    fingerprint: string | null;
  }> {
    const config = (await read()).agentProvider;
    const target = requested ?? config;
    const declaredContextWindow = requested?.declaredContextWindow === undefined
      ? config.declaredContextWindow ?? null
      : requested.declaredContextWindow;
    const workingContextWindow = requested?.workingContextWindow === undefined
      ? config.workingContextWindow ?? null
      : requested.workingContextWindow;
    const credentialEligible = isSavedAgentCredentialEligible(config, target);
    if (!credentialEligible || !config.credentialRevision) {
      return { config, credentialEligible, capabilityReady: false, fingerprint: null };
    }
    const fingerprint = await providerCapabilityFingerprintV1({
      provider: target.provider,
      protocol: target.protocol ?? null,
      baseUrl: target.baseUrl,
      model: target.model,
      credentialRevision: config.credentialRevision,
      declaredContextWindow,
      workingContextWindow,
    });
    return {
      config,
      credentialEligible,
      capabilityReady: config.capability?.fingerprint === fingerprint &&
        config.capability.textChat === true &&
        config.capability.namedToolRoundTrip === true,
      fingerprint,
    };
  },

  async isAgentDataDisclosureAccepted(requested?: {
    provider: Config["agentProvider"]["provider"];
    protocol?: AgentCustomProviderProtocol | null;
    baseUrl: string | null;
  }): Promise<boolean> {
    const config = await read();
    const target = requested ?? config.agentProvider;
    try {
      const endpoint = resolveAgentProviderEndpoint(
        target.provider,
        target.baseUrl,
        target.protocol,
      );
      return isDisclosureAcceptedFor(
        config.agentDataDisclosureAcceptance,
        endpoint.provider,
        endpoint.canonicalOrigin,
      );
    } catch {
      return false;
    }
  },

  async acceptAgentDataDisclosure(input: {
    provider: Config["agentProvider"]["provider"];
    protocol?: AgentCustomProviderProtocol | null;
    baseUrl: string | null;
    acceptedAt?: number;
  }): Promise<AgentDataDisclosureAcceptance> {
    const endpoint = resolveAgentProviderEndpoint(
      input.provider,
      input.baseUrl,
      input.protocol,
    );
    const acceptance = createAgentDataDisclosureAcceptance({
      provider: endpoint.provider,
      origin: endpoint.canonicalOrigin,
      acceptedAt: input.acceptedAt ?? Date.now(),
    });
    const current = await readStoredConfig();
    await write({ ...current, agentDataDisclosureAcceptance: acceptance });
    return acceptance;
  },

  async recordAgentProviderCapability(input: {
    provider: Config["agentProvider"]["provider"];
    protocol?: AgentCustomProviderProtocol | null;
    baseUrl: string | null;
    model: string;
    declaredContextWindow?: number | null;
    workingContextWindow?: number | null;
    credentialSource: "saved" | "transient";
    credentialRevision: string | null;
    verifiedAt: number;
  }): Promise<boolean> {
    if (
      input.credentialSource !== "saved" ||
      !input.credentialRevision ||
      !Number.isSafeInteger(input.verifiedAt) ||
      input.verifiedAt < 0
    ) return false;
    const current = await readStoredConfig();
    const config = current.agentProvider;
    if (
      config.credentialRevision !== input.credentialRevision ||
      !isSavedAgentCredentialEligible(config, input)
    ) return false;
    if (!matchesProviderTarget(config, input)) return false;
    const contextCapability = resolveAgentModelContextCapability({
      provider: input.provider,
      model: input.model,
      declaredContextWindow: input.declaredContextWindow,
    });
    if (!contextCapability) return false;
    const fingerprint = await providerCapabilityFingerprintV1({
      provider: input.provider,
      protocol: input.protocol ?? null,
      baseUrl: input.baseUrl,
      model: input.model,
      credentialRevision: input.credentialRevision,
      declaredContextWindow: input.declaredContextWindow ?? null,
      workingContextWindow: input.workingContextWindow ?? null,
    });
    const latest = await readStoredConfig();
    if (
      latest.agentProvider.credentialRevision !== input.credentialRevision ||
      !sameCredentialRecord(config, latest.agentProvider) ||
      !matchesProviderTarget(latest.agentProvider, input)
    ) return false;
    await write({
      ...latest,
      agentProvider: {
        ...latest.agentProvider,
        capability: {
          fingerprint,
          verifiedAt: input.verifiedAt,
          textChat: true,
          namedToolRoundTrip: true,
          contextCapability,
        },
      },
    });
    return true;
  },

  async invalidateAgentProviderCapability(fingerprint: string): Promise<boolean> {
    if (!/^pcf:v1:[A-Za-z0-9_-]{43}$/u.test(fingerprint)) return false;
    const current = await readStoredConfig();
    if (current.agentProvider.capability?.fingerprint !== fingerprint) return false;
    const latest = await readStoredConfig();
    if (
      latest.agentProvider.capability?.fingerprint !== fingerprint ||
      !sameCredentialRecord(current.agentProvider, latest.agentProvider) ||
      !sameProviderConfiguration(current.agentProvider, latest.agentProvider)
    ) return false;
    await write({
      ...latest,
      agentProvider: {
        ...latest.agentProvider,
        capability: null,
      },
    });
    return true;
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
    plaintextToken = clean;
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

  async updateAgentProviderConfig(patch: {
    provider?: Config["agentProvider"]["provider"];
    protocol?: AgentCustomProviderProtocol | null;
    baseUrl?: string | null;
    model?: string;
    declaredContextWindow?: number | null;
    workingContextWindow?: number | null;
    apiKey?: string;
    clearApiKey?: boolean;
  }): Promise<void> {
    const current = await readStoredConfig();
    const nextProvider = patch.provider ?? current.agentProvider.provider;
    const nextProtocol = patch.protocol === undefined
      ? current.agentProvider.protocol
      : patch.protocol;
    const nextModel =
      patch.model === undefined ? current.agentProvider.model : patch.model;
    const nextDeclaredContextWindow = patch.declaredContextWindow === undefined
      ? current.agentProvider.declaredContextWindow ?? null
      : patch.declaredContextWindow;
    const nextWorkingContextWindow = patch.workingContextWindow === undefined
      ? current.agentProvider.workingContextWindow ?? null
      : patch.workingContextWindow;
    let apiKeyEncrypted = current.agentProvider.apiKeyEncrypted;
    let apiKeyCryptoMeta = current.agentProvider.apiKeyCryptoMeta;
    let credentialScope = current.agentProvider.credentialScope;
    let credentialRevision = current.agentProvider.credentialRevision;
    let capability = current.agentProvider.capability;
    const nextBaseUrl = patch.baseUrl === undefined
      ? current.agentProvider.baseUrl
      : patch.baseUrl;
    const targetChanged =
      patch.provider !== undefined ||
      patch.protocol !== undefined ||
      patch.baseUrl !== undefined;
    const validatedEndpoint = targetChanged
      ? resolveAgentProviderEndpoint(nextProvider, nextBaseUrl, nextProtocol)
      : null;
    let savedReplacementCredential = false;

    if (patch.clearApiKey) {
      apiKeyEncrypted = null;
      apiKeyCryptoMeta = null;
      credentialScope = null;
      credentialRevision = null;
      capability = null;
      plaintextAgentApiKey = null;
    } else if (patch.apiKey !== undefined) {
      const clean = patch.apiKey.trim();
      if (clean) {
        const endpoint = validatedEndpoint ?? resolveAgentProviderEndpoint(
          nextProvider, nextBaseUrl, nextProtocol,
        );
        const { cipher, meta } = await encrypt(clean);
        apiKeyEncrypted = cipher;
        apiKeyCryptoMeta = meta;
        credentialScope = {
          provider: endpoint.provider,
          origin: endpoint.canonicalOrigin,
        };
        credentialRevision = createAgentCredentialRevision();
        capability = null;
        plaintextAgentApiKey = {
          cipher,
          cryptoMeta: JSON.stringify(meta),
          revision: credentialRevision,
          value: clean,
        };
        savedReplacementCredential = true;
      }
    }

    if (!patch.clearApiKey && !savedReplacementCredential) {
      const endpoint = validatedEndpoint ?? resolveAgentProviderEndpoint(
        nextProvider, nextBaseUrl, nextProtocol,
      );
      const credentialTargetChanged = credentialScope?.provider !== endpoint.provider ||
        credentialScope.origin !== endpoint.canonicalOrigin;
      if (credentialTargetChanged) {
        apiKeyEncrypted = null;
        apiKeyCryptoMeta = null;
        credentialScope = null;
        credentialRevision = null;
        capability = null;
        plaintextAgentApiKey = null;
      }
    }

    const latest = await readStoredConfig();
    await write({
      ...latest,
      agentProvider: normalizeAgentProviderConfig({
        provider: nextProvider,
        protocol: nextProtocol,
        baseUrl: nextBaseUrl,
        model: nextModel,
        declaredContextWindow: nextDeclaredContextWindow,
        workingContextWindow: nextWorkingContextWindow,
        apiKeyEncrypted,
        apiKeyCryptoMeta,
        credentialScope,
        credentialRevision,
        capability,
      }),
    });
  },

  async clearAgentProviderApiKey(): Promise<void> {
    await this.updateAgentProviderConfig({ clearApiKey: true });
  },

  async updateAutoTagPolicy(patch: {
    maxTagsPerRepo?: number;
    minTopicRepoCount?: number;
  }): Promise<void> {
    // Fresh-read avoids stale module-cache clobbering across extension contexts.
    const current = await readStoredConfig();
    const maxTagsPerRepo = patch.maxTagsPerRepo === undefined
      ? current.maxTagsPerRepo
      : normalizeMaxTagsPerRepo(patch.maxTagsPerRepo, current.autoTagLimit);
    const minTopicRepoCount = patch.minTopicRepoCount === undefined
      ? current.minTopicRepoCount
      : normalizeMinTopicRepoCount(patch.minTopicRepoCount);
    await write({
      ...current,
      autoTagLimit: maxTagsPerRepo,
      maxTagsPerRepo,
      minTopicRepoCount,
    });
  },

  async updateLibraryViewPrefs(libraryView: Config['libraryView']): Promise<void> {
    // Fresh-read avoids stale module-cache clobbering across extension contexts.
    // This remains last-write-wins, not transactional compare-and-swap.
    const current = await readStoredConfig();
    await write({
      ...current,
      libraryView: normalizeLibraryViewPrefs(libraryView),
    });
  },
};

function normalizeAgentDataDisclosureAcceptance(
  value: unknown,
): AgentDataDisclosureAcceptance | null {
  try {
    validateAgentDataDisclosureAcceptance(value);
    return Object.freeze({ ...value });
  } catch {
    return null;
  }
}
