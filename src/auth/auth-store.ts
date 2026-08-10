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
 * Owns the GitHub PAT lifecycle.
 *
 * The options page collects a classic PAT (with repo, gist, and notifications
 * scopes), verifies the GitHub capabilities this extension needs by reading
 * the `x-oauth-scopes` header, captures account identity, and only then
 * persists the token. Plaintext stays in memory; the stored copy is AES-GCM
 * encrypted in `chrome.storage.local`.
 */

export const CONFIG_STORAGE_KEY = "gsm_config";
export const GITHUB_CREDENTIALS_STORAGE_KEY = 'gsm_github_credentials_v1';

type StoredGitHubCredentials = Readonly<{
  version: 1;
  tokenEncrypted: string | null;
  tokenCryptoMeta: Config['tokenCryptoMeta'];
  username: string | null;
  avatarUrl: string | null;
  displayName: string | null;
}>;

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

type PlaintextCredentialCache = {
  cipher: string;
  cryptoMeta: string;
  value: string;
};

export type GitHubCredentialSnapshot = Readonly<{
  accountLogin: string | null;
  mainToken: string | null;
  mainIdentity: string;
}>;

const CONFIG_OPERATION_LOCK = 'better-github-stars-manager:config:v1';

let cache: Config | null = null;
let plaintextToken: PlaintextCredentialCache | null = null; // in-memory only
let plaintextAgentApiKey: {
  cipher: string;
  cryptoMeta: string;
  revision: string;
  value: string;
} | null = null; // in-memory only
let configOperationTail: Promise<void> = Promise.resolve();

type ConfigLockManager = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

function getConfigLockManager(): ConfigLockManager | null {
  const locks = (globalThis as typeof globalThis & {
    navigator?: { locks?: unknown };
  }).navigator?.locks;
  if (!locks || typeof (locks as { request?: unknown }).request !== 'function') return null;
  return locks as ConfigLockManager;
}

/** Serialize whole-config reads/writes across extension pages and the MV3 worker. */
function runConfigExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const execute = () => {
    const locks = getConfigLockManager();
    return locks ? locks.request(CONFIG_OPERATION_LOCK, operation) : operation();
  };
  const result = configOperationTail.then(execute, execute);
  configOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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

function validCryptoMeta(value: unknown): value is Config['tokenCryptoMeta'] & object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const meta = value as { iv?: unknown; salt?: unknown };
  return typeof meta.iv === 'string' && !!meta.iv && typeof meta.salt === 'string' && !!meta.salt;
}

function credentialsFromConfig(config: Config): StoredGitHubCredentials {
  return {
    version: 1,
    tokenEncrypted: config.tokenEncrypted,
    tokenCryptoMeta: config.tokenCryptoMeta,
    username: config.username,
    avatarUrl: config.avatarUrl,
    displayName: config.displayName,
  };
}

function normalizeStoredGitHubCredentials(value: unknown): StoredGitHubCredentials {
  const stored = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<StoredGitHubCredentials>
    : {};
  const username = typeof stored.username === 'string' && stored.username.trim()
    ? stored.username
    : null;
  const tokenEncrypted = typeof stored.tokenEncrypted === 'string' && stored.tokenEncrypted
    ? stored.tokenEncrypted
    : null;
  const tokenCryptoMeta = validCryptoMeta(stored.tokenCryptoMeta)
    ? stored.tokenCryptoMeta
    : null;
  const hasMainCredential = !!(username && tokenEncrypted && tokenCryptoMeta);
  return {
    version: 1,
    tokenEncrypted: hasMainCredential ? tokenEncrypted : null,
    tokenCryptoMeta: hasMainCredential ? tokenCryptoMeta : null,
    username: hasMainCredential ? username : null,
    avatarUrl: hasMainCredential && typeof stored.avatarUrl === 'string'
      ? stored.avatarUrl
      : null,
    displayName: hasMainCredential && typeof stored.displayName === 'string'
      ? stored.displayName
      : null,
  };
}

function withGitHubCredentials(
  config: Config,
  credentials: StoredGitHubCredentials,
): Config {
  return {
    ...config,
    tokenEncrypted: credentials.tokenEncrypted,
    tokenCryptoMeta: credentials.tokenCryptoMeta,
    username: credentials.username,
    avatarUrl: credentials.avatarUrl,
    displayName: credentials.displayName,
  };
}

function withNormalizedConfig(config: Config): Config {
  const hasTokenHint = !!(plaintextToken?.value || config.tokenEncrypted);
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
  cache = await readStoredConfig();
  return cache;
}

async function readStoredConfig(): Promise<Config> {
  const raw = await chrome.storage.local.get([
    CONFIG_STORAGE_KEY,
    GITHUB_CREDENTIALS_STORAGE_KEY,
  ]);
  const stored = (raw[CONFIG_STORAGE_KEY] ?? {}) as Partial<Config>;
  const hasCredentialRecord = Object.prototype.hasOwnProperty.call(
    raw,
    GITHUB_CREDENTIALS_STORAGE_KEY,
  );
  const credentials = normalizeStoredGitHubCredentials(
    hasCredentialRecord
      ? raw[GITHUB_CREDENTIALS_STORAGE_KEY]
      : { version: 1, ...stored },
  );
  return withNormalizedConfig(withGitHubCredentials(mergeStoredConfig(stored), credentials));
}

function normalizedAccountLogin(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function mainCredentialIdentity(config: Config): string {
  return JSON.stringify([
    normalizedAccountLogin(config.username),
    config.tokenEncrypted,
    config.tokenCryptoMeta,
  ]);
}

async function persistConfigUnlocked(previous: Config, proposed: Config): Promise<Config> {
  const normalized = withNormalizedConfig(withGitHubCredentials(
    proposed,
    credentialsFromConfig(previous),
  ));
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: normalized });
  if (mainCredentialIdentity(previous) !== mainCredentialIdentity(normalized)) {
    plaintextToken = null;
  }
  cache = normalized;
  return normalized;
}

async function persistGitHubCredentialsUnlocked(
  previous: Config,
  proposed: Config,
): Promise<Config> {
  const normalized = withNormalizedConfig(proposed);
  const credentials = normalizeStoredGitHubCredentials(credentialsFromConfig(normalized));
  const next = withGitHubCredentials(normalized, credentials);
  await chrome.storage.local.set({
    [CONFIG_STORAGE_KEY]: next,
    [GITHUB_CREDENTIALS_STORAGE_KEY]: credentials,
  });
  if (mainCredentialIdentity(previous) !== mainCredentialIdentity(next)) {
    plaintextToken = null;
  }
  cache = next;
  return next;
}

async function mutateGitHubCredentials(
  update: (current: Config) => Config | Promise<Config>,
  afterCommit?: (next: Config) => void,
): Promise<Config> {
  return runConfigExclusive(async () => {
    const current = await readStoredConfig();
    const next = await persistGitHubCredentialsUnlocked(current, await update(current));
    afterCommit?.(next);
    return next;
  });
}

async function mutateStoredConfig(
  update: (current: Config) => Config | null | Promise<Config | null>,
  afterCommit?: (next: Config) => void,
): Promise<Config> {
  return runConfigExclusive(async () => {
    const current = await readStoredConfig();
    const proposed = await update(current);
    if (proposed === null) {
      cache = current;
      return current;
    }
    const next = await persistConfigUnlocked(current, proposed);
    afterCommit?.(next);
    return next;
  });
}

async function decryptCredential(
  cipher: string | null,
  meta: Config['tokenCryptoMeta'],
  cached: PlaintextCredentialCache | null,
): Promise<PlaintextCredentialCache | null> {
  if (!cipher || !meta) return null;
  const cryptoMeta = JSON.stringify(meta);
  if (cached?.cipher === cipher && cached.cryptoMeta === cryptoMeta) return cached;
  const value = await decrypt(cipher, meta);
  return value ? { cipher, cryptoMeta, value } : null;
}

async function readDecryptedToken(): Promise<string | null> {
  return runConfigExclusive(async () => {
    const before = await readStoredConfig();
    const decrypted = await decryptCredential(
      before.tokenEncrypted,
      before.tokenCryptoMeta,
      plaintextToken,
    );
    const latest = await readStoredConfig();
    if (mainCredentialIdentity(before) !== mainCredentialIdentity(latest)) return null;
    cache = latest;
    plaintextToken = decrypted;
    return decrypted?.value ?? null;
  });
}

async function readGitHubCredentialSnapshot(): Promise<GitHubCredentialSnapshot> {
  return runConfigExclusive(async () => {
    const before = await readStoredConfig();
    const main = await decryptCredential(
      before.tokenEncrypted,
      before.tokenCryptoMeta,
      plaintextToken,
    );
    const latest = await readStoredConfig();
    const mainIdentity = mainCredentialIdentity(before);
    if (mainIdentity !== mainCredentialIdentity(latest)) {
      return {
        accountLogin: normalizedAccountLogin(latest.username),
        mainToken: null,
        mainIdentity: mainCredentialIdentity(latest),
      };
    }
    cache = latest;
    plaintextToken = main;
    return {
      accountLogin: normalizedAccountLogin(before.username),
      mainToken: main?.value ?? null,
      mainIdentity,
    };
  });
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
    const configChange = changes[CONFIG_STORAGE_KEY];
    const credentialsChange = changes[GITHUB_CREDENTIALS_STORAGE_KEY];
    if (!configChange && !credentialsChange) return;

    const prev = cache;
    const stored = (configChange?.newValue ?? cache ?? {}) as Partial<Config>;
    const credentials = credentialsChange
      ? normalizeStoredGitHubCredentials(credentialsChange.newValue)
      : prev
        ? credentialsFromConfig(prev)
        : normalizeStoredGitHubCredentials({ version: 1, ...stored });
    cache = withNormalizedConfig(withGitHubCredentials(
      mergeStoredConfig(stored),
      credentials,
    ));

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

  /** A single account-bound credential view for background Watch operations. */
  async getGitHubCredentialSnapshot(): Promise<GitHubCredentialSnapshot> {
    return readGitHubCredentialSnapshot();
  },

  /** The decrypted AI service API key, or null. Held only in memory. */
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
    await mutateStoredConfig((current) => ({
      ...current,
      agentDataDisclosureAcceptance: acceptance,
    }));
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
    let recorded = false;
    await mutateStoredConfig((current) => {
      const config = current.agentProvider;
      if (
        config.credentialRevision !== input.credentialRevision ||
        !isSavedAgentCredentialEligible(config, input) ||
        !matchesProviderTarget(config, input)
      ) return null;
      recorded = true;
      return {
        ...current,
        agentProvider: {
          ...config,
          capability: {
            fingerprint,
            verifiedAt: input.verifiedAt,
            textChat: true,
            namedToolRoundTrip: true,
            contextCapability,
          },
        },
      };
    });
    return recorded;
  },

  async invalidateAgentProviderCapability(fingerprint: string): Promise<boolean> {
    if (!/^pcf:v1:[A-Za-z0-9_-]{43}$/u.test(fingerprint)) return false;
    let invalidated = false;
    await mutateStoredConfig((current) => {
      if (current.agentProvider.capability?.fingerprint !== fingerprint) return null;
      invalidated = true;
      return {
        ...current,
        agentProvider: {
          ...current.agentProvider,
          capability: null,
        },
      };
    });
    return invalidated;
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
    await mutateStoredConfig((current) => ({ ...current, theme }));
  },

  async setLocale(locale: "en" | "zh-CN"): Promise<void> {
    await mutateStoredConfig((current) => ({ ...current, locale }));
  },

  /**
   * Verify the PAT has the permissions we need (probeTokenCapabilities), then
   * encrypt+persist. Failure throws an errors.ts code; the token is never
   * persisted on failure.
   */
  async setToken(token: string): Promise<{
    username: string;
  }> {
    const clean = token.trim();
    if (!clean) throw new Error(TOKEN_EMPTY);

    const { login, avatarUrl, displayName } = await probeTokenCapabilities(clean);
    const { cipher, meta } = await encrypt(clean);
    await mutateGitHubCredentials((current) => {
      const onboardingStage =
        current.onboardingStage === "done" ? "done" : "awaiting_sync";
      return {
        ...current,
        tokenEncrypted: cipher,
        tokenCryptoMeta: meta,
        username: login,
        avatarUrl,
        displayName,
        onboardingStage,
      };
    }, () => {
      plaintextToken = { cipher, cryptoMeta: JSON.stringify(meta), value: clean };
    });
    return { username: login };
  },

  async clearToken(): Promise<void> {
    await mutateGitHubCredentials((current) => {
      const onboardingStage =
        current.onboardingStage === "done" ? "done" : "needs_token";
      return {
        ...current,
        tokenEncrypted: null,
        tokenCryptoMeta: null,
        username: null,
        avatarUrl: null,
        displayName: null,
        onboardingStage,
      };
    }, () => {
      plaintextToken = null;
    });
  },

  async update(patch: Partial<Config>): Promise<void> {
    const touchesGitHubCredentials = [
      'tokenEncrypted',
      'tokenCryptoMeta',
      'username',
      'avatarUrl',
      'displayName',
    ].some((key) => Object.prototype.hasOwnProperty.call(patch, key));
    if (touchesGitHubCredentials) {
      await mutateGitHubCredentials((current) => ({ ...current, ...patch }));
      return;
    }
    await mutateStoredConfig((current) => ({ ...current, ...patch }));
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
    const initial = await readStoredConfig();
    const initialProvider = initial.agentProvider;
    const nextProvider = patch.provider ?? initialProvider.provider;
    const nextProtocol = patch.protocol === undefined
      ? initialProvider.protocol
      : patch.protocol;
    const nextModel = patch.model === undefined ? initialProvider.model : patch.model;
    const nextDeclaredContextWindow = patch.declaredContextWindow === undefined
      ? initialProvider.declaredContextWindow ?? null
      : patch.declaredContextWindow;
    const nextWorkingContextWindow = patch.workingContextWindow === undefined
      ? initialProvider.workingContextWindow ?? null
      : patch.workingContextWindow;
    const nextBaseUrl = patch.baseUrl === undefined
      ? initialProvider.baseUrl
      : patch.baseUrl;
    const targetChanged = patch.provider !== undefined ||
      patch.protocol !== undefined || patch.baseUrl !== undefined;
    const validatedEndpoint = targetChanged
      ? resolveAgentProviderEndpoint(nextProvider, nextBaseUrl, nextProtocol)
      : null;
    let replacementCredential: {
      cipher: string;
      meta: NonNullable<Config['agentProvider']['apiKeyCryptoMeta']>;
      scope: NonNullable<Config['agentProvider']['credentialScope']>;
      revision: string;
      value: string;
    } | null = null;
    const cleanApiKey = patch.apiKey?.trim() ?? null;
    if (!patch.clearApiKey && cleanApiKey) {
      const endpoint = validatedEndpoint ?? resolveAgentProviderEndpoint(
        nextProvider, nextBaseUrl, nextProtocol,
      );
      const { cipher, meta } = await encrypt(cleanApiKey);
      const revision = createAgentCredentialRevision();
      replacementCredential = {
        cipher,
        meta,
        scope: {
          provider: endpoint.provider,
          origin: endpoint.canonicalOrigin,
        },
        revision,
        value: cleanApiKey,
      };
    }
    const initialMutationIdentity = JSON.stringify([
      initialProvider.provider,
      initialProvider.protocol,
      initialProvider.baseUrl,
      initialProvider.apiKeyEncrypted,
      initialProvider.apiKeyCryptoMeta,
      initialProvider.credentialRevision,
      initialProvider.credentialScope,
    ]);
    let nextPlaintextAgentApiKey = plaintextAgentApiKey;
    await mutateStoredConfig((current) => {
      const currentProvider = current.agentProvider;
      const currentMutationIdentity = JSON.stringify([
        currentProvider.provider,
        currentProvider.protocol,
        currentProvider.baseUrl,
        currentProvider.apiKeyEncrypted,
        currentProvider.apiKeyCryptoMeta,
        currentProvider.credentialRevision,
        currentProvider.credentialScope,
      ]);
      if (
        (patch.clearApiKey || replacementCredential || targetChanged) &&
        currentMutationIdentity !== initialMutationIdentity
      ) return null;

      let apiKeyEncrypted = currentProvider.apiKeyEncrypted;
      let apiKeyCryptoMeta = currentProvider.apiKeyCryptoMeta;
      let credentialScope = currentProvider.credentialScope;
      let credentialRevision = currentProvider.credentialRevision;
      let capability = currentProvider.capability;
      if (patch.clearApiKey) {
        apiKeyEncrypted = null;
        apiKeyCryptoMeta = null;
        credentialScope = null;
        credentialRevision = null;
        capability = null;
        nextPlaintextAgentApiKey = null;
      } else if (replacementCredential) {
        apiKeyEncrypted = replacementCredential.cipher;
        apiKeyCryptoMeta = replacementCredential.meta;
        credentialScope = replacementCredential.scope;
        credentialRevision = replacementCredential.revision;
        capability = null;
        nextPlaintextAgentApiKey = {
          cipher: replacementCredential.cipher,
          cryptoMeta: JSON.stringify(replacementCredential.meta),
          revision: replacementCredential.revision,
          value: replacementCredential.value,
        };
      } else {
        const endpoint = validatedEndpoint ?? resolveAgentProviderEndpoint(
          nextProvider, nextBaseUrl, nextProtocol,
        );
        const credentialTargetChanged = credentialScope?.provider !== endpoint.provider ||
          credentialScope?.origin !== endpoint.canonicalOrigin;
        if (credentialTargetChanged) {
          apiKeyEncrypted = null;
          apiKeyCryptoMeta = null;
          credentialScope = null;
          credentialRevision = null;
          capability = null;
          nextPlaintextAgentApiKey = null;
        }
      }

      return {
        ...current,
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
      };
    }, () => {
      plaintextAgentApiKey = nextPlaintextAgentApiKey;
    });
  },

  async clearAgentProviderApiKey(): Promise<void> {
    await this.updateAgentProviderConfig({ clearApiKey: true });
  },

  async updateAutoTagPolicy(patch: {
    maxTagsPerRepo?: number;
    minTopicRepoCount?: number;
  }): Promise<void> {
    await mutateStoredConfig((current) => {
      const maxTagsPerRepo = patch.maxTagsPerRepo === undefined
        ? current.maxTagsPerRepo
        : normalizeMaxTagsPerRepo(patch.maxTagsPerRepo, current.autoTagLimit);
      const minTopicRepoCount = patch.minTopicRepoCount === undefined
        ? current.minTopicRepoCount
        : normalizeMinTopicRepoCount(patch.minTopicRepoCount);
      return {
        ...current,
        autoTagLimit: maxTagsPerRepo,
        maxTagsPerRepo,
        minTopicRepoCount,
      };
    });
  },

  async updateLibraryViewPrefs(libraryView: Config['libraryView']): Promise<void> {
    await mutateStoredConfig((current) => ({
      ...current,
      libraryView: normalizeLibraryViewPrefs(libraryView),
    }));
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
