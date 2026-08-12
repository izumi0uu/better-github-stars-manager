import { useEffect, useRef, useState } from "react";
import {
  Sun,
  Moon,
  Star,
  Check,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import {
  authStore,
  CONFIG_STORAGE_KEY,
  GITHUB_CREDENTIALS_STORAGE_KEY,
} from "@/auth/auth-store";
import {
  BackgroundCallError,
  bgCall,
  mergeProgressStatus,
  mergeStatusSnapshot,
  onProgress,
  type SyncStatus,
} from "@/utils/messaging";
import {
  TOKEN_WATCHING_FORBIDDEN,
  translateError,
} from "@/api/errors";
import {
  OPTIONS_INTENT_STORAGE_KEY,
  consumeOptionsIntent,
  parseOptionsIntent,
} from "@/utils/options-intent";
import { Button } from "@/ui/shadcn/button";
import { Progress } from "@/ui/shadcn/progress";
import { Spinner } from "@/ui/shadcn/spinner";
import { Textarea } from "@/ui/shadcn/textarea";
import { Separator } from "@/ui/shadcn/separator";
import { Input } from "@/ui/shadcn/input";
import { Checkbox } from "@/ui/shadcn/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/shadcn/select";
import { cn } from "@/lib/utils";
import { REPO_URL } from "@/lib/links";
import { useImeBufferedInput } from "@/ui/hooks/use-ime-input";
import { useI18n } from "@/i18n";
import {
  DEFAULT_AUTO_TAG_LIMIT,
  DEFAULT_MIN_TOPIC_REPO_COUNT,
  MAX_AUTO_TAG_LIMIT,
  MIN_AUTO_TAG_LIMIT,
  normalizeMaxTagsPerRepo,
  normalizeMinTopicRepoCount,
} from "@/preferences";
import {
  getProvider as getAgentProvider,
  getProviders as getAgentProviders,
  isSavedAgentCredentialEligible,
  resolveAgentModelContextCapability,
  resolveAgentProviderEndpoint,
  trustedAgentModelContextCapability,
} from "@/agent-harness/models";
import {
  getAgentProviderHostAccess,
  hasAgentProviderHostPermission,
  requestAgentProviderHostPermission,
} from "@/agent-harness/provider-access";
import type {
  AgentCustomProviderProtocol,
  AgentProviderConfig,
  AgentProviderId,
} from "@/types";
import type {
  AgentStorageCleanupResult,
  AgentStorageUsageSnapshot,
} from "@/storage/agent-storage-store";
import { AgentDataDisclosurePanel } from "./AgentDataDisclosurePanel";
import {
  AgentStoragePanel,
  formatStorageBytes,
} from "./AgentStoragePanel";

const tutorialNewToken = "/tutorial/img_01.png";
const tutorialRepoAccess = "/tutorial/img_02.png";
const tutorialPermissions = "/tutorial/img_03.png";
const agentProviders = getAgentProviders();
const DEFAULT_CUSTOM_AGENT_PROTOCOL: AgentCustomProviderProtocol = "chat-completions";
const MIN_AGENT_CONTEXT_WINDOW = 4_096;
const MAX_AGENT_CONTEXT_WINDOW = 2_000_000;

type OptionsMessage = { kind: "ok" | "warn" | "err"; text: string };
type AgentConnectionResult = {
  providerLabel: string;
  model: string;
  latencyMs: number;
  preview: string;
};
function StatusNotice({
  message,
  className,
  testId,
}: {
  message: OptionsMessage;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      role={message.kind === "err" ? "alert" : "status"}
      aria-live={message.kind === "err" ? "assertive" : "polite"}
      className={cn(
        "gsm-status-note",
        className,
        {
          "text-success": message.kind === "ok",
          "text-warning": message.kind === "warn",
          "text-destructive": message.kind === "err",
        },
      )}
    >
      {message.text}
    </div>
  );
}

export function Options() {
  const [username, setUsername] = useState<string | null>(null);
  const [hasUsableToken, setHasUsableToken] = useState(false);
  const [gistId, setGistId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [agentProvider, setAgentProvider] = useState<AgentProviderId>("openai");
  const [agentProtocol, setAgentProtocol] =
    useState<AgentCustomProviderProtocol>(DEFAULT_CUSTOM_AGENT_PROTOCOL);
  const [agentBaseUrl, setAgentBaseUrl] = useState("");
  const [agentModel, setAgentModel] = useState(
    getAgentProvider("openai").defaultModel,
  );
  const [agentDeclaredContextWindow, setAgentDeclaredContextWindow] = useState("");
  const [agentWorkingContextWindow, setAgentWorkingContextWindow] = useState("");
  const [agentApiKey, setAgentApiKey] = useState("");
  const [hasSavedAgentApiKey, setHasSavedAgentApiKey] = useState(false);
  const [savedAgentProviderConfig, setSavedAgentProviderConfig] =
    useState<AgentProviderConfig | null>(null);
  const [agentHostAccessGranted, setAgentHostAccessGranted] = useState(false);
  const [agentHostAccessBusy, setAgentHostAccessBusy] = useState(false);
  const [maxTagsPerRepo, setMaxTagsPerRepo] = useState<string>(String(DEFAULT_AUTO_TAG_LIMIT));
  const [minTopicRepoCount, setMinTopicRepoCount] = useState<string>(String(DEFAULT_MIN_TOPIC_REPO_COUNT));
  const persistedMaxTagsPerRepoRef = useRef(String(DEFAULT_AUTO_TAG_LIMIT));
  const persistedMinTopicRepoCountRef = useRef(String(DEFAULT_MIN_TOPIC_REPO_COUNT));
  const [starsPanelDefaultEnabled, setStarsPanelDefaultEnabled] = useState(true);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [agentSaveBusy, setAgentSaveBusy] = useState(false);
  const [agentTestBusy, setAgentTestBusy] = useState(false);
  const [agentStorageUsage, setAgentStorageUsage] =
    useState<AgentStorageUsageSnapshot | null>(null);
  const [agentStorageLoading, setAgentStorageLoading] = useState(true);
  const [agentStorageClearBusy, setAgentStorageClearBusy] = useState(false);
  const [agentStorageError, setAgentStorageError] = useState<string | null>(null);
  const [agentStorageNotice, setAgentStorageNotice] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [msg, setMsg] = useState<OptionsMessage | null>(null);
  const [watchMsg, setWatchMsg] = useState<OptionsMessage | null>(null);
  const [agentMsg, setAgentMsg] = useState<OptionsMessage | null>(null);
  const { locale, setLocale, m } = useI18n();
  const tokenInput = useImeBufferedInput("");
  const refreshGeneration = useRef(0);
  const tokenHeadingRef = useRef<HTMLHeadingElement>(null);
  const watchHeadingRef = useRef<HTMLHeadingElement>(null);

  const loadAgentStorageUsage = async () => {
    setAgentStorageLoading(true);
    setAgentStorageError(null);
    try {
      const usage = await bgCall<AgentStorageUsageSnapshot>("getAgentStorageUsage");
      setAgentStorageUsage(usage);
    } catch (error) {
      const message = error instanceof BackgroundCallError
        ? error.message
        : translateError(error, m);
      setAgentStorageError(m.options.agentStorageUnavailable(message));
    } finally {
      setAgentStorageLoading(false);
    }
  };

  const refresh = async () => {
    const generation = ++refreshGeneration.current;
    const [c, hasToken, status] = await Promise.all([
      authStore.getConfig(),
      authStore.hasToken(),
      bgCall<SyncStatus>("getStatus").catch(() => null),
    ]);
    if (generation !== refreshGeneration.current) return;
    setUsername(c.username);
    setHasUsableToken(hasToken);
    // The main Classic PAT is the only GitHub credential.
    setGistId(c.gistId);
    setTheme(c.theme);
    setAgentProvider(c.agentProvider.provider);
    setAgentProtocol(
      c.agentProvider.protocol ?? DEFAULT_CUSTOM_AGENT_PROTOCOL,
    );
    setAgentBaseUrl(c.agentProvider.baseUrl ?? "");
    setAgentModel(c.agentProvider.model);
    setAgentDeclaredContextWindow(
      c.agentProvider.declaredContextWindow == null
        ? ""
        : String(c.agentProvider.declaredContextWindow),
    );
    setAgentWorkingContextWindow(
      c.agentProvider.workingContextWindow == null
        ? ""
        : String(c.agentProvider.workingContextWindow),
    );
    setSavedAgentProviderConfig(c.agentProvider);
    setHasSavedAgentApiKey(
      !!(c.agentProvider.apiKeyEncrypted && c.agentProvider.apiKeyCryptoMeta),
    );
    setMaxTagsPerRepo(String(c.maxTagsPerRepo));
    setMinTopicRepoCount(String(c.minTopicRepoCount));
    persistedMaxTagsPerRepoRef.current = String(c.maxTagsPerRepo);
    persistedMinTopicRepoCountRef.current = String(c.minTopicRepoCount);
    setStarsPanelDefaultEnabled(c.starsPanelDefaultEnabled);
    setSyncStatus((current) => mergeStatusSnapshot(current, status));
  };
  useEffect(() => {
    void refresh();
    const off = onProgress((progress) => {
      setSyncStatus((current) =>
        mergeProgressStatus(current, progress, hasUsableToken),
      );
    });
    return off;
  }, [hasUsableToken]);

  useEffect(() => {
    void loadAgentStorageUsage();
  }, []);

  // Deep-link from credential recovery actions: consume the transient session
  // intent on mount and on later writes to an already-open Options page.
  useEffect(() => {
    let cancelled = false;
    const applyOptionsIntent = async () => {
      const intent = await consumeOptionsIntent();
      if (cancelled || !intent) return;
      const heading = intent.section === "github"
        ? tokenHeadingRef.current
        : watchHeadingRef.current;
      if (!heading) return;
      heading.scrollIntoView?.({ block: "start" });
      heading.focus({ preventScroll: true });
    };
    void applyOptionsIntent();
    const handleStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "session") return;
      const change = changes[OPTIONS_INTENT_STORAGE_KEY];
      if (!change || !parseOptionsIntent(change.newValue)) return;
      void applyOptionsIntent();
    };
    chrome.storage.onChanged.addListener(handleStorageChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(handleStorageChanged);
    };
  }, []);

  const saveToken = async () => {
    setTokenBusy(true);
    setMsg(null);
    try {
      const { username: u, notifications } = await authStore.setToken(tokenInput.value);
      setMsg(notifications.available
        ? { kind: "ok", text: m.options.tokenVerified(u) }
        : {
            kind: "warn",
            text: notifications.errorCode === TOKEN_WATCHING_FORBIDDEN
              ? m.options.tokenVerifiedWatchForbidden(u)
              : m.options.tokenVerifiedWatchUnverified(u),
          });
      tokenInput.commit("");
      await refresh();
    } catch (e) {
      setMsg({ kind: "err", text: translateError(e, m) });
    } finally {
      setTokenBusy(false);
    }
  };

  const clearToken = async () => {
    await authStore.clearToken();
    await refresh();
    setMsg({ kind: "ok", text: m.options.tokenRemoved });
  };

  const disconnectWatchNotifications = async () => {
    setWatchMsg(null);
    try {
      await bgCall("disconnectWatchInbox");
      await refresh();
      setWatchMsg({ kind: "ok", text: m.options.watchTokenDisconnected });
    } catch (error) {
      setWatchMsg({ kind: "err", text: translateError(error, m) });
    }
  };

  const requestAgentConnectionTest = (apiKey?: string) => bgCall<AgentConnectionResult>(
    "testAgentProviderConnection",
    {
      provider: agentProvider,
      protocol: agentProvider === "custom-openai-compatible" ? agentProtocol : null,
      baseUrl: agentProvider === "custom-openai-compatible" ? agentBaseUrl : null,
      model: agentModel,
      declaredContextWindow: resolvedDeclaredContextWindow,
      workingContextWindow: parsedWorkingContextWindow,
      apiKey,
    },
  );
  const formatAgentConnectionError = (error: unknown) => (
    error instanceof BackgroundCallError ? error.message : translateError(error, m)
  );

  const saveAgentSettings = async () => {
    setAgentSaveBusy(true);
    setAgentMsg(null);
    try {
      await authStore.updateAgentProviderConfig({
        provider: agentProvider,
        protocol: agentProvider === "custom-openai-compatible" ? agentProtocol : null,
        baseUrl:
          agentProvider === "custom-openai-compatible" ? agentBaseUrl : null,
        model: agentModel,
        declaredContextWindow: resolvedDeclaredContextWindow,
        workingContextWindow: parsedWorkingContextWindow,
        apiKey: agentApiKey,
      });
      setAgentApiKey("");
      await refresh();
      const target = agentDisclosureTarget;
      const hasHostAccess = !!target && await hasAgentProviderHostPermission(
        target.provider,
        target.canonicalBaseUrl,
      );
      setAgentHostAccessGranted(hasHostAccess);
      if (!hasHostAccess) {
        setAgentMsg({ kind: "ok", text: m.options.agentSavedNeedsHostAccess });
        return;
      }
      try {
        const result = await requestAgentConnectionTest();
        await refresh();
        setAgentMsg({
          kind: "ok",
          text: m.options.agentSavedAndTested(
            result.providerLabel,
            result.model,
            result.latencyMs,
          ),
        });
      } catch (error) {
        setAgentMsg({
          kind: "err",
          text: m.options.agentSavedTestFailed(formatAgentConnectionError(error)),
        });
      }
    } catch (e) {
      setAgentMsg({ kind: "err", text: formatAgentConnectionError(e) });
    } finally {
      setAgentSaveBusy(false);
    }
  };

  const clearAgentApiKey = async () => {
    setAgentMsg(null);
    try {
      await authStore.clearAgentProviderApiKey();
      setAgentApiKey("");
      await refresh();
      setAgentMsg({ kind: "ok", text: m.options.agentKeyRemoved });
    } catch (e) {
      setAgentMsg({ kind: "err", text: translateError(e, m) });
    }
  };

  const clearAgentToolCache = async () => {
    setAgentStorageClearBusy(true);
    setAgentStorageError(null);
    setAgentStorageNotice(null);
    try {
      const result = await bgCall<AgentStorageCleanupResult>("clearAgentToolCache");
      setAgentStorageUsage(result.usage);
      setAgentStorageNotice(m.options.agentStorageCacheCleared(
        result.deletedArtifacts,
        formatStorageBytes(result.freedBytes, locale),
        result.protectedArtifacts,
      ));
    } catch (error) {
      const message = error instanceof BackgroundCallError
        ? error.message
        : translateError(error, m);
      setAgentStorageError(m.options.agentStorageClearFailed(message));
    } finally {
      setAgentStorageClearBusy(false);
    }
  };

  const testAgentConnection = async () => {
    const permissionTarget = agentDisclosureTarget;
    setAgentTestBusy(true);
    setAgentMsg(null);
    try {
      const result = await requestAgentConnectionTest(agentApiKey.trim() || undefined);
      setAgentMsg({
        kind: "ok",
        text: m.options.agentTestOk(
          result.providerLabel,
          result.model,
          result.latencyMs,
        ),
      });
    } catch (e) {
      setAgentMsg({ kind: "err", text: formatAgentConnectionError(e) });
    } finally {
      if (permissionTarget) {
        const granted = await hasAgentProviderHostPermission(
          permissionTarget.provider,
          permissionTarget.canonicalBaseUrl,
        );
        setAgentHostAccessGranted(granted);
      }
      setAgentTestBusy(false);
    }
  };

  const changeAgentProvider = (next: AgentProviderId) => {
    setAgentMsg(null);
    setAgentProvider(next);
    setAgentModel(getAgentProvider(next).defaultModel);
  };

  const grantAgentHostAccess = async () => {
    if (!agentDisclosureTarget) return;
    setAgentHostAccessBusy(true);
    setAgentMsg(null);
    try {
      await requestAgentProviderHostPermission(
        agentDisclosureTarget.provider,
        agentDisclosureTarget.canonicalBaseUrl,
      );
      setAgentHostAccessGranted(true);
    } catch (e) {
      setAgentHostAccessGranted(false);
      setAgentMsg({ kind: "err", text: translateError(e, m) });
    } finally {
      setAgentHostAccessBusy(false);
    }
  };

  const toggleTheme = async () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    await authStore.setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
  };

  const saveMaxTagsPerRepo = async (raw: string) => {
    const next = normalizeMaxTagsPerRepo(raw);
    setMaxTagsPerRepo(String(next)); // clamp the field back to a legal value
    try {
      await authStore.updateAutoTagPolicy({ maxTagsPerRepo: next });
      persistedMaxTagsPerRepoRef.current = String(next);
    } catch (e) {
      setMaxTagsPerRepo(persistedMaxTagsPerRepoRef.current);
      setMsg({ kind: "err", text: translateError(e, m) });
    }
  };

  const saveMinTopicRepoCount = async (raw: string) => {
    const next = normalizeMinTopicRepoCount(raw);
    setMinTopicRepoCount(String(next));
    try {
      await authStore.updateAutoTagPolicy({ minTopicRepoCount: next });
      persistedMinTopicRepoCountRef.current = String(next);
    } catch (e) {
      setMinTopicRepoCount(persistedMinTopicRepoCountRef.current);
      setMsg({ kind: "err", text: translateError(e, m) });
    }
  };

  const toggleStarsPanelDefaultEnabled = async (checked: boolean) => {
    setStarsPanelDefaultEnabled(checked);
    await authStore.update({ starsPanelDefaultEnabled: checked });
  };

  const syncing = !!(
    syncStatus?.inFlight && syncStatus.progress && syncStatus.progress.phase !== "idle"
  );
  const progressValue = syncStatus?.progress.total
    ? Math.max(
        1,
        Math.min(
          100,
          Math.round(
            (syncStatus.progress.done / syncStatus.progress.total) * 100,
          ),
        ),
      )
    : null;
  const progressCount = syncStatus?.progress.total
    ? `${syncStatus.progress.done}/${syncStatus.progress.total}`
    : null;
  const gistUrl = gistId
    ? `https://gist.github.com/${username ? `${username}/` : ""}${gistId}`
    : null;
  const starsUrl =
    hasUsableToken && username ? `https://github.com/${username}?tab=stars` : null;
  const customAgentSelected = agentProvider === "custom-openai-compatible";
  const trustedAgentContextCapability = trustedAgentModelContextCapability(
    agentProvider,
    agentModel,
  );
  const agentDeclaredContextRequired = !trustedAgentContextCapability;
  const agentDeclaredContextVisible = customAgentSelected || agentDeclaredContextRequired;
  const parsedDeclaredContextWindow = parseAgentContextWindow(agentDeclaredContextWindow);
  const parsedWorkingContextWindow = parseAgentContextWindow(agentWorkingContextWindow);
  const agentDeclaredContextValid = parsedDeclaredContextWindow !== undefined &&
    (!agentDeclaredContextRequired || parsedDeclaredContextWindow !== null);
  const resolvedDeclaredContextWindow = customAgentSelected || agentDeclaredContextRequired
    ? parsedDeclaredContextWindow ?? null
    : null;
  const selectedProviderContextWindow = resolveAgentModelContextCapability({
    provider: agentProvider,
    model: agentModel,
    declaredContextWindow: resolvedDeclaredContextWindow,
  })?.contextWindow;
  const agentWorkingContextExceedsProvider = parsedWorkingContextWindow != null &&
    selectedProviderContextWindow != null &&
    parsedWorkingContextWindow > selectedProviderContextWindow;
  const agentWorkingContextValid = parsedWorkingContextWindow !== undefined &&
    !agentWorkingContextExceedsProvider;
  const agentContextSettingsValid = agentDeclaredContextValid && agentWorkingContextValid;
  const agentBaseUrlReady = !customAgentSelected || !!agentBaseUrl.trim();
  const hasEligibleSavedAgentApiKey = !!savedAgentProviderConfig &&
    isSavedAgentCredentialEligible(savedAgentProviderConfig, {
      provider: agentProvider,
      baseUrl: customAgentSelected ? agentBaseUrl : null,
    });
  const agentDisclosureTarget = resolveDisclosureTarget(
    agentProvider,
    customAgentSelected ? agentBaseUrl : null,
    customAgentSelected ? agentProtocol : null,
  );
  const customAgentHostAccessRequired = !!agentDisclosureTarget &&
    getAgentProviderHostAccess(
      agentDisclosureTarget.provider,
      agentDisclosureTarget.canonicalBaseUrl,
    ).kind === "optional";
  const canTestAgentConnection =
    !!(agentApiKey.trim() || hasEligibleSavedAgentApiKey) &&
    agentBaseUrlReady &&
    agentContextSettingsValid &&
    agentHostAccessGranted;

  useEffect(() => {
    let current = true;
    if (!agentDisclosureTarget) {
      setAgentHostAccessGranted(false);
      return () => {
        current = false;
      };
    }
    const refreshHostAccess = () => hasAgentProviderHostPermission(
      agentDisclosureTarget.provider,
      agentDisclosureTarget.canonicalBaseUrl,
    ).then((granted) => {
      if (current) setAgentHostAccessGranted(granted);
    });
    const handlePermissionChange = () => {
      void refreshHostAccess();
    };
    const permissionAddedEvent = chrome.permissions.onAdded as chrome.permissions.PermissionsAddedEvent & {
      removeListener?: (listener: typeof handlePermissionChange) => void;
    };
    const permissionRemovedEvent = chrome.permissions.onRemoved as chrome.permissions.PermissionsRemovedEvent & {
      removeListener?: (listener: typeof handlePermissionChange) => void;
    };
    void refreshHostAccess();
    permissionAddedEvent.addListener(handlePermissionChange);
    permissionRemovedEvent.addListener(handlePermissionChange);
    return () => {
      current = false;
      permissionAddedEvent.removeListener?.(handlePermissionChange);
      permissionRemovedEvent.removeListener?.(handlePermissionChange);
    };
  }, [agentDisclosureTarget?.canonicalOrigin, agentDisclosureTarget?.provider]);

  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local") return;
      if (changes[GITHUB_CREDENTIALS_STORAGE_KEY]) {
        void refresh();
        return;
      }
      if (!changes[CONFIG_STORAGE_KEY]) return;
      const oldCfg = changes[CONFIG_STORAGE_KEY].oldValue as Record<string, unknown> | undefined;
      const newCfg = changes[CONFIG_STORAGE_KEY].newValue as Record<string, unknown> | undefined;
      const visibleConfigUnchanged =
        oldCfg?.username === newCfg?.username &&
        oldCfg?.gistId === newCfg?.gistId &&
        oldCfg?.theme === newCfg?.theme &&
        oldCfg?.locale === newCfg?.locale &&
        oldCfg?.tokenEncrypted === newCfg?.tokenEncrypted &&
        JSON.stringify(oldCfg?.tokenCryptoMeta ?? null) ===
          JSON.stringify(newCfg?.tokenCryptoMeta ?? null) &&
        oldCfg?.githubCredentialStatus === newCfg?.githubCredentialStatus &&
        oldCfg?.watchNotificationsEnabled === newCfg?.watchNotificationsEnabled &&
        JSON.stringify(oldCfg?.agentProvider ?? null) ===
          JSON.stringify(newCfg?.agentProvider ?? null) &&
        oldCfg?.maxTagsPerRepo === newCfg?.maxTagsPerRepo &&
        oldCfg?.minTopicRepoCount === newCfg?.minTopicRepoCount &&
        oldCfg?.starsPanelDefaultEnabled === newCfg?.starsPanelDefaultEnabled;
      if (visibleConfigUnchanged) return;
      void refresh();
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  return (
    <div className="mx-auto my-10 max-w-2xl rounded-lg bg-background p-7 font-sans text-foreground">
      {/* Header: title on the left, Language + Theme controls on the right
          (the old Language/Appearance sections collapsed into compact controls). */}
      <div className="flex items-start justify-between gap-3">
        <h1 className="mt-0 inline-flex items-center gap-1.5 text-xl font-semibold">
          <Star className="size-5 fill-current text-primary" />
          {m.options.title}
        </h1>
        <div className="flex items-center gap-2">
          {/* Language: compact EN / 中文 segmented toggle */}
          <div
            className="inline-flex rounded-full bg-muted p-0.5"
            role="group"
            aria-label={m.options.languageLabel}
          >
            {(["en", "zh-CN"] as const).map((lng) => {
              const active = locale === lng;
              return (
                <button
                  key={lng}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    if (!active) void setLocale(lng);
                  }}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                    {
                      "bg-primary text-primary-foreground shadow-sm": active,
                      "text-muted-foreground hover:text-foreground": !active,
                    },
                  )}
                >
                  {lng === "en" ? "EN" : "中文"}
                </button>
              );
            })}
          </div>
          {/* Theme: icon toggle */}
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            onClick={toggleTheme}
            title={m.toolbar.themeTitle}
          >
            {theme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Star the project — prominent CTA under the header. */}
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        <Star className="size-4" />
        {m.options.starRepoButton}
      </a>

      {/* 1. Token */}
      <section className="mt-6">
        <h2
          id="github-connection-heading"
          ref={tokenHeadingRef}
          tabIndex={-1}
          className="text-base font-medium"
        >
          {m.options.tokenHeading}
        </h2>
        <p className="gsm-body-note mt-1">
          {m.options.tokenIntroPrefix}{" "}
          <a
            className="text-primary hover:underline"
            href="https://github.com/settings/tokens/new?scopes=repo,gist,notifications&description=Better%20GitHub%20Stars%20Manager"
            target="_blank"
            rel="noreferrer"
          >
            {m.options.tokenLinkLabel}
          </a>
          . {m.options.tokenIntroSuffix}
        </p>

        {/* Detailed PAT walkthrough with tutorial screenshots. Captions live in i18n. */}
        <details className="gsm-status-note mt-3 rounded-md border border-border bg-muted/20 p-3 text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">
            {m.options.tokenStepsTitle}
          </summary>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 leading-relaxed">
            <li>{m.options.tokenStep1}</li>
            <li>{m.options.tokenStep2}</li>
            <li>{m.options.tokenStep3}</li>
            <li>{m.options.tokenStep4}</li>
            <li>{m.options.tokenStep5}</li>
          </ol>
          <div className="mt-3 grid gap-2">
            <ScreenshotCard
              src={tutorialNewToken}
              caption={m.options.shotNewToken}
            />
            <ScreenshotCard
              src={tutorialRepoAccess}
              caption={m.options.shotRepoAccess}
            />
            <ScreenshotCard
              src={tutorialPermissions}
              caption={m.options.shotPermissions}
            />
          </div>
        </details>

        <ul className="gsm-body-note mt-2">
          <li>{m.options.tokenPublicRepos}</li>
          <li>{m.options.tokenGists}</li>
          <li>{m.options.tokenWatchingOptional}</li>
          <li>{m.options.tokenIssuesOptional}</li>
          <li>{m.options.tokenFollowersOptional}</li>
        </ul>
        <p className="mt-1 text-xs text-warning">{m.options.tokenGistNote}</p>

        {hasUsableToken && username && (
          <div className="gsm-status-note my-3 flex flex-wrap items-center gap-1.5 text-success">
            <Check className="size-4 shrink-0" />
            <span>{m.options.authenticatedAs(username)}</span>
            {starsUrl && (
              <a
                href={starsUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                {m.options.openVerifiedStars}
                <ExternalLink className="size-3.5" />
              </a>
            )}
            <Button variant="ghost" size="sm" className="ml-2" onClick={clearToken}>
              {m.options.removeToken}
            </Button>
          </div>
        )}
        {!hasUsableToken && username && (
          <div className="gsm-status-note my-3 flex items-center gap-1.5 text-warning">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{m.options.cachedAccountWarning(username)}</span>
            <Button variant="ghost" size="sm" className="ml-2" onClick={clearToken}>
              {m.options.clearCachedAuth}
            </Button>
          </div>
        )}

        <Textarea
          {...tokenInput.inputProps}
          placeholder="github_pat_..."
          rows={2}
          className="mt-1 font-mono"
        />
        <div className="mt-2">
          <Button disabled={tokenBusy || !tokenInput.value.trim()} onClick={saveToken}>
            {tokenBusy ? (
              <>
                <Spinner data-icon="inline-start" />
                {m.options.verifying}
              </>
            ) : (
              m.options.saveVerify
            )}
          </Button>
        </div>
        {msg && (
          <StatusNotice
            message={msg}
            className="mt-3"
            testId="main-token-status"
          />
        )}
      </section>

      {/* Watch uses the optional Notifications capability on the single PAT. */}
      <section className="mt-6" data-testid="watch-inbox-settings">
        <h2
          id="watch-inbox-heading"
          ref={watchHeadingRef}
          tabIndex={-1}
          className="text-base font-medium"
        >
          {m.options.watchTokenHeading}
        </h2>
        <p className="gsm-body-note mt-1">{m.options.watchSetupDescription}</p>
        <p className="gsm-body-note mt-2">{m.options.watchSetupOtherFeaturesSafe}</p>
        {hasUsableToken && (
          <Button
            data-testid="watch-token-disconnect"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => void disconnectWatchNotifications()}
          >
            {m.options.watchTokenDisconnect}
          </Button>
        )}
        {!hasUsableToken && (
          <p className="mt-2 text-xs text-warning">{m.options.watchTokenMainRequired}</p>
        )}
        {watchMsg && (
          <StatusNotice
            message={watchMsg}
            className="mt-3"
            testId="watch-token-status"
          />
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-base font-medium">{m.options.agentHeading}</h2>
        <p className="gsm-body-note mt-1">{m.options.agentIntro}</p>
        <div className="mt-3 grid gap-4 rounded-lg border border-border bg-muted/20 p-4">
          <div className="grid gap-1.5">
            <label
              htmlFor="agent-provider"
              className="text-sm font-medium text-foreground"
            >
              {m.options.agentServiceLabel}
            </label>
            <p className="gsm-body-note">{m.options.agentServiceHint}</p>
            <Select
              value={agentProvider}
              onValueChange={(value) =>
                changeAgentProvider(value as AgentProviderId)
              }
            >
              <SelectTrigger id="agent-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {agentProviders.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <details
            className="border-t border-border pt-3"
            data-testid="agent-advanced-settings"
          >
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              {m.options.agentAdvancedSettings}
            </summary>
            <div className="mt-3 grid gap-4">
              {customAgentSelected && (
                <div className="grid gap-1.5">
                  <span
                    id="agent-protocol-label"
                    className="text-sm font-medium text-foreground"
                  >
                    {m.options.agentProtocolLabel}
                  </span>
                  <p className="gsm-body-note">{m.options.agentProtocolHint}</p>
                  <div
                    className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/20 p-1"
                    role="group"
                    aria-labelledby="agent-protocol-label"
                  >
                    {([
                      ["chat-completions", m.options.agentProtocolChat],
                      ["responses", m.options.agentProtocolResponses],
                    ] as const).map(([protocol, label]) => {
                      const selected = agentProtocol === protocol;
                      return (
                        <button
                          key={protocol}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => {
                            setAgentMsg(null);
                            setAgentProtocol(protocol);
                          }}
                          className={cn(
                            "min-h-9 rounded px-3 py-2 text-sm font-medium transition-colors",
                            {
                              "bg-primary text-primary-foreground shadow-sm": selected,
                              "text-muted-foreground hover:bg-muted hover:text-foreground": !selected,
                            },
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {customAgentSelected && (
                <div className="grid gap-1.5">
                  <label
                    htmlFor="agent-base-url"
                    className="text-sm font-medium text-foreground"
                  >
                    {m.options.agentBaseUrlLabel}
                  </label>
                  <p className="gsm-body-note">{m.options.agentBaseUrlHint}</p>
                  <Input
                    id="agent-base-url"
                    value={agentBaseUrl}
                    onChange={(event) => {
                      setAgentMsg(null);
                      setAgentBaseUrl(event.currentTarget.value);
                    }}
                    placeholder={m.options.agentBaseUrlPlaceholder}
                    className="font-mono"
                  />
                </div>
              )}

              {agentDeclaredContextVisible && (
                <div className="grid gap-1.5">
                    <label
                      htmlFor="agent-provider-context-window"
                      className="text-sm font-medium text-foreground"
                    >
                      {m.options.agentProviderContextWindowLabel}
                    </label>
                    <p className="gsm-body-note">
                      {m.options.agentProviderContextWindowHint}
                    </p>
                    <Input
                      id="agent-provider-context-window"
                      data-testid="agent-provider-context-window"
                      type="number"
                      inputMode="numeric"
                      min={MIN_AGENT_CONTEXT_WINDOW}
                      max={MAX_AGENT_CONTEXT_WINDOW}
                      step={1}
                      required={agentDeclaredContextRequired}
                      aria-invalid={!agentDeclaredContextValid}
                      value={agentDeclaredContextWindow}
                      onChange={(event) => {
                        setAgentMsg(null);
                        setAgentDeclaredContextWindow(event.currentTarget.value);
                      }}
                      placeholder={trustedAgentContextCapability
                        ? String(trustedAgentContextCapability.contextWindow)
                        : "128000"}
                    />
                    {!agentDeclaredContextValid && (
                      <p className="text-xs text-destructive" role="alert">
                        {agentDeclaredContextWindow.trim()
                          ? m.options.agentContextWindowRange
                          : m.options.agentProviderContextWindowRequired}
                      </p>
                    )}
                </div>
              )}

              <div className="grid gap-1.5">
                  <label
                    htmlFor="agent-working-context-window"
                    className="text-sm font-medium text-foreground"
                  >
                    {m.options.agentWorkingContextWindowLabel}
                  </label>
                  <p className="gsm-body-note">
                    {m.options.agentWorkingContextWindowHint}
                  </p>
                  <Input
                    id="agent-working-context-window"
                    data-testid="agent-working-context-window"
                    type="number"
                    inputMode="numeric"
                    min={MIN_AGENT_CONTEXT_WINDOW}
                    max={MAX_AGENT_CONTEXT_WINDOW}
                    step={1}
                    aria-invalid={!agentWorkingContextValid}
                    value={agentWorkingContextWindow}
                    onChange={(event) => {
                      setAgentMsg(null);
                      setAgentWorkingContextWindow(event.currentTarget.value);
                    }}
                    placeholder={m.options.agentWorkingContextWindowPlaceholder}
                  />
                {!agentWorkingContextValid && (
                  <p className="text-xs text-destructive" role="alert">
                    {agentWorkingContextExceedsProvider
                      ? m.options.agentWorkingContextWindowTooLarge
                      : m.options.agentContextWindowRange}
                  </p>
                )}
              </div>
            </div>
          </details>

          <div className="grid gap-1.5">
            <label
              htmlFor="agent-model"
              className="text-sm font-medium text-foreground"
            >
              {m.options.agentModelLabel}
            </label>
            <p className="gsm-body-note">{m.options.agentModelHint}</p>
            <Input
              id="agent-model"
              value={agentModel}
              onChange={(event) => {
                setAgentMsg(null);
                setAgentModel(event.currentTarget.value);
              }}
              placeholder={getAgentProvider(agentProvider).defaultModel}
              className="font-mono"
            />
          </div>

          <div className="grid gap-1.5">
            <label
              htmlFor="agent-api-key"
              className="text-sm font-medium text-foreground"
            >
              {m.options.agentApiKeyLabel}
            </label>
            <p className="gsm-body-note">{m.options.agentApiKeyHint}</p>
            <Input
              id="agent-api-key"
              type="password"
              value={agentApiKey}
              onChange={(event) => {
                setAgentMsg(null);
                setAgentApiKey(event.currentTarget.value);
              }}
              placeholder={m.options.agentApiKeyPlaceholder}
              className="font-mono"
            />
            {hasEligibleSavedAgentApiKey && !agentApiKey.trim() && (
              <p className="gsm-body-note">{m.options.agentSavedKeyHint}</p>
            )}
          </div>

          {agentDisclosureTarget && (
            <AgentDataDisclosurePanel
              providerLabel={getAgentProvider(agentDisclosureTarget.provider).label}
              canonicalOrigin={agentDisclosureTarget.canonicalOrigin}
              customHostAccessRequired={customAgentHostAccessRequired}
              hostAccessGranted={agentHostAccessGranted}
              hostAccessBusy={
                agentHostAccessBusy || agentSaveBusy || agentTestBusy
              }
              onGrantAccess={() => void grantAgentHostAccess()}
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={saveAgentSettings}
              disabled={
                agentSaveBusy ||
                agentHostAccessBusy ||
                agentTestBusy ||
                !agentModel.trim() ||
                !agentBaseUrlReady ||
                !agentContextSettingsValid
              }
            >
              {agentSaveBusy ? (
                <>
                  <Spinner data-icon="inline-start" />
                  {m.options.agentSaving}
                </>
              ) : (
                m.options.agentSave
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => void testAgentConnection()}
              disabled={
                agentTestBusy ||
                agentSaveBusy ||
                agentHostAccessBusy ||
                !agentModel.trim() ||
                !canTestAgentConnection
              }
            >
              {agentTestBusy ? (
                <>
                  <Spinner data-icon="inline-start" />
                  {m.options.agentTesting}
                </>
              ) : (
                m.options.agentTest
              )}
            </Button>
            {hasSavedAgentApiKey && (
              <Button variant="ghost" onClick={() => void clearAgentApiKey()}>
                {m.options.agentRemoveKey}
              </Button>
            )}
          </div>
          {agentMsg && (
            <StatusNotice message={agentMsg} testId="agent-connection-status" />
          )}
        </div>
        <AgentStoragePanel
          usage={agentStorageUsage}
          loading={agentStorageLoading}
          clearBusy={agentStorageClearBusy}
          error={agentStorageError}
          notice={agentStorageNotice}
          onRefresh={loadAgentStorageUsage}
          onClearToolCache={clearAgentToolCache}
        />
      </section>

      <Separator className="my-6" />

      {/* 4. Gist */}
      <section>
        <h2 className="text-base font-medium">{m.options.gistHeading}</h2>
        <p className="gsm-status-note mt-1 text-muted-foreground">
          {gistId ? (
            <>
              {m.options.gistBoundPrefix} <code>{gistId}</code>.{" "}
              {m.options.gistBoundSuffix}
            </>
          ) : (
            <>{m.options.gistEmpty}</>
          )}
        </p>
        {gistUrl && (
          <a
            className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
            href={gistUrl}
            target="_blank"
            rel="noreferrer"
          >
            {m.options.gistOpenLink}
            <ExternalLink className="size-3.5" />
          </a>
        )}
        <div className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <div className="inline-flex items-center gap-2">
            {syncing && <Spinner className="size-3" />}
            {syncStatus?.progress
              ? `${syncing ? `${m.common.phase(syncStatus.progress.phase)}: ` : ""}${syncStatus.progress.message || m.popup.idle}`
              : m.popup.idle}
          </div>
          {syncing && progressValue != null && (
            <div className="mt-2 flex items-center gap-2">
              <Progress value={progressValue} className="h-2 flex-1" />
              <span className="gsm-progress-count">
                {progressCount}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* 5. Preference */}
      <section className="mt-6">
        <h2 className="text-base font-medium">{m.options.behaviorHeading}</h2>
        <div className="mt-3 grid gap-4 rounded-lg border border-border bg-muted/20 p-4">
          <NumericPrefField
            id="max-tags-per-repo"
            label={m.options.maxTagsPerRepoLabel}
            hint={m.options.maxTagsPerRepoHint}
            value={maxTagsPerRepo}
            onChange={setMaxTagsPerRepo}
            onSave={saveMaxTagsPerRepo}
          />

          <NumericPrefField
            id="min-topic-repo-count"
            label={m.options.minTopicRepoCountLabel}
            hint={m.options.minTopicRepoCountHint}
            value={minTopicRepoCount}
            onChange={setMinTopicRepoCount}
            onSave={saveMinTopicRepoCount}
          />

          <div className="flex items-start gap-3">
            <Checkbox
              id="stars-panel-default"
              checked={starsPanelDefaultEnabled}
              onCheckedChange={(checked) =>
                void toggleStarsPanelDefaultEnabled(checked === true)
              }
              aria-describedby="stars-panel-default-hint"
              className="mt-0.5"
            />
            <label
              htmlFor="stars-panel-default"
              className="grid cursor-pointer gap-1"
            >
              <span className="text-sm font-medium text-foreground">
                {m.options.starsPanelDefaultLabel}
              </span>
              <span
                id="stars-panel-default-hint"
                className="gsm-body-note"
              >
                {m.options.starsPanelDefaultHint}
              </span>
            </label>
          </div>
        </div>
      </section>
    </div>
  );
}

function parseAgentContextWindow(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_AGENT_CONTEXT_WINDOW ||
    parsed > MAX_AGENT_CONTEXT_WINDOW
  ) return undefined;
  return parsed;
}

function resolveDisclosureTarget(
  provider: AgentProviderId,
  baseUrl: string | null,
  protocol: AgentCustomProviderProtocol | null,
) {
  try {
    return resolveAgentProviderEndpoint(provider, baseUrl, protocol);
  } catch {
    return null;
  }
}

function NumericPrefField({
  id,
  label,
  hint,
  value,
  onChange,
  onSave,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  onSave: (value: string) => Promise<void>;
}) {
  const hintId = `${id}-hint`;

  return (
    <div className="grid gap-1.5">
      <label
        htmlFor={id}
        className="text-sm font-medium text-foreground"
      >
        {label}
      </label>
      <p
        id={hintId}
        className="gsm-body-note"
      >
        {hint}
      </p>
      <div className="flex items-center gap-3">
        <Input
          id={id}
          type="number"
          min={MIN_AUTO_TAG_LIMIT}
          max={MAX_AUTO_TAG_LIMIT}
          step={1}
          value={value}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.currentTarget.value)}
          onBlur={(event) => void onSave(event.currentTarget.value)}
          className="w-24"
        />
        <span
          className="text-xs text-muted-foreground"
          aria-hidden="true"
        >
          {MIN_AUTO_TAG_LIMIT}–{MAX_AUTO_TAG_LIMIT}
        </span>
      </div>
    </div>
  );
}

function ScreenshotCard({ src, caption }: { src: string; caption: string }) {
  return (
    <figure className="overflow-hidden rounded-md border border-border bg-muted/30">
      <img
        src={src}
        alt={caption}
        loading="lazy"
        decoding="async"
        className="block w-full"
      />
      <figcaption className="gsm-helper-text border-t border-border px-3 py-2">
        {caption}
      </figcaption>
    </figure>
  );
}
