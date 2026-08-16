import { useEffect, useRef, useState } from "react";
import { authStore } from "@/auth/auth-store";
import {
  hasAgentPersonalCommunicationsPermission,
  requestAgentPersonalCommunicationsPermission,
} from "@/auth/agent-data-permission";
import { BackgroundCallError, bgCall } from "@/utils/messaging";
import {
  AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED,
  translateError,
} from "@/api/errors";
import { Button } from "@/ui/shadcn/button";
import { Spinner } from "@/ui/shadcn/spinner";
import { Input } from "@/ui/shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/shadcn/select";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import {
  getProvider as getAgentProvider,
  type AgentProviderEndpoint,
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
import { isDisclosureAcceptedFor } from "@/bgsm-agent/disclosure";
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

const agentProviders = getAgentProviders();
const DEFAULT_CUSTOM_AGENT_PROTOCOL: AgentCustomProviderProtocol = "chat-completions";
const MIN_AGENT_CONTEXT_WINDOW = 4_096;
const MAX_AGENT_CONTEXT_WINDOW = 2_000_000;

export type OptionsAgentSettingsSnapshot = Readonly<{
  providerConfig: AgentProviderConfig;
}>;

export const DEFAULT_OPTIONS_AGENT_SETTINGS_SNAPSHOT: OptionsAgentSettingsSnapshot = {
  providerConfig: {
    provider: "openai",
    protocol: null,
    baseUrl: null,
    model: getAgentProvider("openai").defaultModel,
    declaredContextWindow: null,
    workingContextWindow: null,
    apiKeyEncrypted: null,
    apiKeyCryptoMeta: null,
    credentialScope: null,
    credentialRevision: null,
    capability: null,
  },
};

type AgentConnectionResult = {
  providerLabel: string;
  model: string;
  latencyMs: number;
  preview: string;
};

type AgentMessage = { kind: "ok" | "warn" | "err"; text: string };

type OptionsAgentSettingsProps = {
  snapshot: OptionsAgentSettingsSnapshot;
  onRefresh: () => Promise<void>;
};

export function OptionsAgentSettings({
  snapshot,
  onRefresh,
}: OptionsAgentSettingsProps) {
  const initial = snapshot.providerConfig;
  const [agentProvider, setAgentProvider] = useState<AgentProviderId>(initial.provider);
  const [agentProtocol, setAgentProtocol] = useState<AgentCustomProviderProtocol>(
    initial.protocol ?? DEFAULT_CUSTOM_AGENT_PROTOCOL,
  );
  const [agentBaseUrl, setAgentBaseUrl] = useState(initial.baseUrl ?? "");
  const [agentModel, setAgentModel] = useState(initial.model);
  const [agentDeclaredContextWindow, setAgentDeclaredContextWindow] = useState(
    initial.declaredContextWindow == null ? "" : String(initial.declaredContextWindow),
  );
  const [agentWorkingContextWindow, setAgentWorkingContextWindow] = useState(
    initial.workingContextWindow == null ? "" : String(initial.workingContextWindow),
  );
  const [agentApiKey, setAgentApiKey] = useState("");
  const [savedAgentProviderConfig, setSavedAgentProviderConfig] =
    useState<AgentProviderConfig>(initial);
  const [hasSavedAgentApiKey, setHasSavedAgentApiKey] = useState(
    !!(initial.apiKeyEncrypted && initial.apiKeyCryptoMeta),
  );
  const [agentHostAccessGranted, setAgentHostAccessGranted] = useState(false);
  const [agentHostAccessBusy, setAgentHostAccessBusy] = useState(false);
  const [agentDisclosureAccepted, setAgentDisclosureAccepted] = useState(false);
  const [agentDisclosureBusy, setAgentDisclosureBusy] = useState(false);
  const agentDisclosureTargetRef = useRef<AgentProviderEndpoint | null>(null);
  const [agentSaveBusy, setAgentSaveBusy] = useState(false);
  const [agentTestBusy, setAgentTestBusy] = useState(false);
  const [agentStorageUsage, setAgentStorageUsage] =
    useState<AgentStorageUsageSnapshot | null>(null);
  const [agentStorageLoading, setAgentStorageLoading] = useState(true);
  const [agentStorageClearBusy, setAgentStorageClearBusy] = useState(false);
  const [agentStorageError, setAgentStorageError] = useState<string | null>(null);
  const [agentStorageNotice, setAgentStorageNotice] = useState<string | null>(null);
  const [agentMsg, setAgentMsg] = useState<AgentMessage | null>(null);
  const { locale, m } = useI18n();

  useEffect(() => {
    const providerConfig = snapshot.providerConfig;
    setAgentProvider(providerConfig.provider);
    setAgentProtocol(providerConfig.protocol ?? DEFAULT_CUSTOM_AGENT_PROTOCOL);
    setAgentBaseUrl(providerConfig.baseUrl ?? "");
    setAgentModel(providerConfig.model);
    setAgentDeclaredContextWindow(
      providerConfig.declaredContextWindow == null
        ? ""
        : String(providerConfig.declaredContextWindow),
    );
    setAgentWorkingContextWindow(
      providerConfig.workingContextWindow == null
        ? ""
        : String(providerConfig.workingContextWindow),
    );
    setSavedAgentProviderConfig(providerConfig);
    setHasSavedAgentApiKey(
      !!(providerConfig.apiKeyEncrypted && providerConfig.apiKeyCryptoMeta),
    );
  }, [snapshot]);

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

  useEffect(() => {
    void loadAgentStorageUsage();
  }, []);

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
  const hasEligibleSavedAgentApiKey = isSavedAgentCredentialEligible(
    savedAgentProviderConfig,
    {
      provider: agentProvider,
      baseUrl: customAgentSelected ? agentBaseUrl : null,
    },
  );
  const agentDisclosureTarget = resolveDisclosureTarget(
    agentProvider,
    customAgentSelected ? agentBaseUrl : null,
    customAgentSelected ? agentProtocol : null,
  );
  agentDisclosureTargetRef.current = agentDisclosureTarget;
  const customAgentHostAccessRequired = !!agentDisclosureTarget &&
    getAgentProviderHostAccess(
      agentDisclosureTarget.provider,
      agentDisclosureTarget.canonicalBaseUrl,
    ).kind === "optional";
  const canTestAgentConnection =
    !!(agentApiKey.trim() || hasEligibleSavedAgentApiKey) &&
    agentBaseUrlReady &&
    agentContextSettingsValid &&
    agentDisclosureAccepted &&
    agentHostAccessGranted;

  useEffect(() => {
    let current = true;
    if (!agentDisclosureTarget) {
      setAgentHostAccessGranted(false);
      setAgentDisclosureAccepted(false);
      return () => {
        current = false;
      };
    }
    const refreshPermissions = async () => {
      const [hostAccessGranted, config, dataCollectionPermissionGranted] = await Promise.all([
        hasAgentProviderHostPermission(
          agentDisclosureTarget.provider,
          agentDisclosureTarget.canonicalBaseUrl,
        ),
        authStore.getConfig(),
        hasAgentPersonalCommunicationsPermission(),
      ]);
      if (!current) return;
      setAgentHostAccessGranted(hostAccessGranted);
      setAgentDisclosureAccepted(
        dataCollectionPermissionGranted && isDisclosureAcceptedFor(
          config.agentDataDisclosureAcceptance,
          agentDisclosureTarget.provider,
          agentDisclosureTarget.canonicalOrigin,
        ),
      );
    };
    const handlePermissionChange = () => {
      void refreshPermissions();
    };
    const permissionAddedEvent = chrome.permissions.onAdded as chrome.permissions.PermissionsAddedEvent & {
      removeListener?: (listener: typeof handlePermissionChange) => void;
    };
    const permissionRemovedEvent = chrome.permissions.onRemoved as chrome.permissions.PermissionsRemovedEvent & {
      removeListener?: (listener: typeof handlePermissionChange) => void;
    };
    void refreshPermissions();
    permissionAddedEvent.addListener(handlePermissionChange);
    permissionRemovedEvent.addListener(handlePermissionChange);
    return () => {
      current = false;
      permissionAddedEvent.removeListener?.(handlePermissionChange);
      permissionRemovedEvent.removeListener?.(handlePermissionChange);
    };
  }, [agentDisclosureTarget?.canonicalOrigin, agentDisclosureTarget?.provider]);

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
      await onRefresh();
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
        await onRefresh();
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
    } catch (error) {
      setAgentMsg({ kind: "err", text: formatAgentConnectionError(error) });
    } finally {
      setAgentSaveBusy(false);
    }
  };

  const clearAgentApiKey = async () => {
    setAgentMsg(null);
    try {
      await authStore.clearAgentProviderApiKey();
      setAgentApiKey("");
      await onRefresh();
      setAgentMsg({ kind: "ok", text: m.options.agentKeyRemoved });
    } catch (error) {
      setAgentMsg({ kind: "err", text: translateError(error, m) });
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
    } catch (error) {
      setAgentMsg({ kind: "err", text: formatAgentConnectionError(error) });
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
  const acceptAgentDisclosure = async () => {
    if (!agentDisclosureTarget) return;
    const target = agentDisclosureTarget;
    setAgentDisclosureBusy(true);
    setAgentMsg(null);
    try {
      const permission = await requestAgentPersonalCommunicationsPermission();
      if (permission === "denied") {
        throw new Error(AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED);
      }
      const currentTarget = agentDisclosureTargetRef.current;
      if (
        !currentTarget ||
        currentTarget.provider !== target.provider ||
        currentTarget.canonicalOrigin !== target.canonicalOrigin
      ) return;
      await authStore.acceptAgentDataDisclosure({
        provider: target.provider,
        protocol: target.provider === "custom-openai-compatible"
          ? target.profile.protocol as AgentCustomProviderProtocol
          : null,
        baseUrl: target.canonicalBaseUrl,
      });
      const acceptedTarget = agentDisclosureTargetRef.current;
      setAgentDisclosureAccepted(
        acceptedTarget?.provider === target.provider &&
        acceptedTarget.canonicalOrigin === target.canonicalOrigin,
      );
    } catch (error) {
      setAgentDisclosureAccepted(false);
      setAgentMsg({ kind: "err", text: translateError(error, m) });
    } finally {
      setAgentDisclosureBusy(false);
    }
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
    } catch (error) {
      setAgentHostAccessGranted(false);
      setAgentMsg({ kind: "err", text: translateError(error, m) });
    } finally {
      setAgentHostAccessBusy(false);
    }
  };


  return (
    <section>
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
            disclosureAccepted={agentDisclosureAccepted}
            disclosureBusy={agentDisclosureBusy}
            customHostAccessRequired={customAgentHostAccessRequired}
            hostAccessGranted={agentHostAccessGranted}
            hostAccessBusy={
              agentHostAccessBusy || agentDisclosureBusy || agentSaveBusy || agentTestBusy
            }
            onAcceptDisclosure={() => void acceptAgentDisclosure()}
            onGrantAccess={() => void grantAgentHostAccess()}
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={saveAgentSettings}
            disabled={
              agentSaveBusy ||
              agentDisclosureBusy ||
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
              agentDisclosureBusy ||
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
        {agentMsg && <AgentStatusNotice message={agentMsg} />}
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
  );
}

export function parseAgentContextWindow(value: string): number | null | undefined {
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

export function resolveDisclosureTarget(
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

function AgentStatusNotice({ message }: { message: AgentMessage }) {
  return (
    <div
      data-testid="agent-connection-status"
      role={message.kind === "err" ? "alert" : "status"}
      aria-live={message.kind === "err" ? "assertive" : "polite"}
      className={cn("gsm-status-note", {
        "text-success": message.kind === "ok",
        "text-warning": message.kind === "warn",
        "text-destructive": message.kind === "err",
      })}
    >
      {message.text}
    </div>
  );
}
