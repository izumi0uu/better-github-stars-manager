import { useEffect, useRef, useState } from "react";
import {
  Sun,
  Moon,
  Star,
  Heart,
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
import type { FollowingHistoryWindowDays } from '@/types';
import {
  DEFAULT_AUTO_TAG_LIMIT,
  DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS,
  FOLLOWING_HISTORY_WINDOW_OPTIONS,
  DEFAULT_MIN_TOPIC_REPO_COUNT,
  MAX_AUTO_TAG_LIMIT,
  MIN_AUTO_TAG_LIMIT,
  normalizeMaxTagsPerRepo,
  normalizeFollowingHistoryWindowDays,
  normalizeMinTopicRepoCount,
} from "@/preferences";
import {
  CURRENT_EXTENSION_STORE_LISTING,
} from '@/store-rating';
import tokenGuideCreateUrl from "../../store-assets/screenshots/token-guide-create-classic-pat.webp?url";
import tokenGuideScopesUrl from "../../store-assets/screenshots/token-guide-select-scopes.webp?url";
import tokenGuideGenerateUrl from "../../store-assets/screenshots/token-guide-generate-token.webp?url";
import {
  DEFAULT_OPTIONS_AGENT_SETTINGS_SNAPSHOT,
  OptionsAgentSettings,
  type OptionsAgentSettingsSnapshot,
} from "./OptionsAgentSettings";


type OptionsMessage = { kind: "ok" | "warn" | "err"; text: string };
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
  const [agentSettingsSnapshot, setAgentSettingsSnapshot] =
    useState<OptionsAgentSettingsSnapshot>(DEFAULT_OPTIONS_AGENT_SETTINGS_SNAPSHOT);
  const [radarWindowDays, setRadarWindowDays] = useState<FollowingHistoryWindowDays>(
    DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS,
  );
  const [maxTagsPerRepo, setMaxTagsPerRepo] = useState<string>(String(DEFAULT_AUTO_TAG_LIMIT));
  const [minTopicRepoCount, setMinTopicRepoCount] = useState<string>(String(DEFAULT_MIN_TOPIC_REPO_COUNT));
  const persistedMaxTagsPerRepoRef = useRef(String(DEFAULT_AUTO_TAG_LIMIT));
  const persistedMinTopicRepoCountRef = useRef(String(DEFAULT_MIN_TOPIC_REPO_COUNT));
  const persistedRadarWindowDaysRef = useRef<FollowingHistoryWindowDays>(
    DEFAULT_FOLLOWING_HISTORY_WINDOW_DAYS,
  );
  const [starsPanelDefaultEnabled, setStarsPanelDefaultEnabled] = useState(true);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [msg, setMsg] = useState<OptionsMessage | null>(null);
  const [storeRatingMessage, setStoreRatingMessage] = useState<OptionsMessage | null>(null);
  const { locale, setLocale, m } = useI18n();
  const tokenInput = useImeBufferedInput("");
  const refreshGeneration = useRef(0);
  const tokenHeadingRef = useRef<HTMLHeadingElement>(null);


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
    setAgentSettingsSnapshot({ providerConfig: c.agentProvider });
    setRadarWindowDays(c.radarWindowDays);
    setMaxTagsPerRepo(String(c.maxTagsPerRepo));
    setMinTopicRepoCount(String(c.minTopicRepoCount));
    persistedMaxTagsPerRepoRef.current = String(c.maxTagsPerRepo);
    persistedMinTopicRepoCountRef.current = String(c.minTopicRepoCount);
    persistedRadarWindowDaysRef.current = c.radarWindowDays;
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


  // Deep-link from credential recovery actions: consume the transient session
  // intent on mount and on later writes to an already-open Options page.
  useEffect(() => {
    let cancelled = false;
    const applyOptionsIntent = async () => {
      const intent = await consumeOptionsIntent();
      if (cancelled || !intent) return;
      const heading = tokenHeadingRef.current;
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



  const toggleTheme = async () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    await authStore.setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
  };


  const saveRadarWindowDays = async (raw: string) => {
    const next = normalizeFollowingHistoryWindowDays(raw);
    setRadarWindowDays(next);
    try {
      await authStore.update({ radarWindowDays: next });
      persistedRadarWindowDaysRef.current = next;
    } catch (error) {
      setRadarWindowDays(persistedRadarWindowDaysRef.current);
      setMsg({ kind: "err", text: translateError(error, m) });
    }
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

  const markStoreRatingOpened = () => {
    setStoreRatingMessage(null);
    void authStore.recordStoreRatingNavigation()
      .catch((error) => {
        setStoreRatingMessage({ kind: "err", text: translateError(error, m) });
      });
  };

  const syncing = !!(
    syncStatus?.progressInFlight && syncStatus.progress && syncStatus.progress.phase !== "idle"
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
        oldCfg?.radarWindowDays === newCfg?.radarWindowDays &&
        oldCfg?.starsPanelDefaultEnabled === newCfg?.starsPanelDefaultEnabled &&
        JSON.stringify(oldCfg?.storeRatingPrompt ?? null) ===
          JSON.stringify(newCfg?.storeRatingPrompt ?? null);
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

      {/* 1. GitHub connection */}
      <section className="mt-6" data-testid="github-connection-settings">
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
            className="text-primary underline"
            href="https://github.com/settings/tokens/new?scopes=repo,gist,notifications,read:user&description=Better%20GitHub%20Stars%20Manager"
            target="_blank"
            rel="noreferrer"
          >
            {m.options.tokenLinkLabel}
          </a>
          . {m.options.tokenIntroSuffix}
        </p>

        <details
          data-testid="token-setup-guide"
          className="gsm-status-note mt-3 rounded-md border border-border bg-muted/20 p-3 text-muted-foreground"
        >
          <summary className="cursor-pointer font-medium text-foreground">
            {m.options.tokenStepsTitle}
          </summary>
          <ol className="mt-3 grid list-decimal gap-4 pl-5 leading-relaxed">
            <li className="pl-1">
              <p className="font-medium text-foreground">{m.options.tokenStep1Title}</p>
              <p className="mt-1">{m.options.tokenStep1}</p>
              <img
                src={tokenGuideCreateUrl}
                alt={m.options.tokenStep1Alt}
                width={1568}
                height={875}
                loading="lazy"
                decoding="async"
                className="mt-2 h-auto w-full rounded-md border border-border bg-background object-contain"
              />
            </li>
            <li className="pl-1">
              <p className="font-medium text-foreground">{m.options.tokenStep2Title}</p>
              <p className="mt-1">{m.options.tokenStep2}</p>
              <img
                src={tokenGuideScopesUrl}
                alt={m.options.tokenStep2Alt}
                width={1568}
                height={520}
                loading="lazy"
                decoding="async"
                className="mt-2 h-auto w-full rounded-md border border-border bg-background object-contain"
              />
            </li>
            <li className="pl-1">
              <p className="font-medium text-foreground">{m.options.tokenStep3Title}</p>
              <p className="mt-1">{m.options.tokenStep3}</p>
              <img
                src={tokenGuideGenerateUrl}
                alt={m.options.tokenStep3Alt}
                width={888}
                height={290}
                loading="lazy"
                decoding="async"
                className="mt-2 h-auto w-full rounded-md border border-border bg-background object-contain"
              />
            </li>
          </ol>
          <p className="mt-3 text-xs text-warning">{m.options.tokenScopesWarning}</p>
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

      <Separator className="my-6" />

      <OptionsAgentSettings
        snapshot={agentSettingsSnapshot}
        onRefresh={refresh}
      />

      <Separator className="my-6" />

      {/* 3. Gist */}
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

      {/* 4. Preferences */}
      <section className="mt-6">
        <h2 className="text-base font-medium">{m.options.behaviorHeading}</h2>
        <div className="mt-3 grid gap-4 rounded-lg border border-border bg-muted/20 p-4">
          <div className="grid gap-1.5">
            <label
              id="following-history-window-label"
              htmlFor="following-history-window"
              className="text-sm font-medium text-foreground"
            >
              {m.options.followingHistoryWindowLabel}
            </label>
            <p id="following-history-window-hint" className="gsm-body-note">
              {m.options.followingHistoryWindowHint}
            </p>
            <Select
              value={String(radarWindowDays)}
              onValueChange={(value) => void saveRadarWindowDays(value)}
            >
              <SelectTrigger
                id="following-history-window"
                data-testid="following-history-window"
                aria-labelledby="following-history-window-label"
                aria-describedby="following-history-window-hint following-history-window-risk"
                className="w-36"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FOLLOWING_HISTORY_WINDOW_OPTIONS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {m.options.followingHistoryWindowOption(days)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p
              id="following-history-window-risk"
              className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
              <span>{m.options.followingHistoryWindowRisk}</span>
            </p>
          </div>

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

          {CURRENT_EXTENSION_STORE_LISTING && (
            <div
              className="grid gap-3 border-t border-border pt-4"
              data-testid="store-rating-settings"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="grid min-w-0 gap-1">
                  <span className="text-sm font-medium text-foreground">
                    {m.options.storeRatingHeading}
                  </span>
                  <span className="gsm-body-note">
                    {m.options.storeRatingManualHint(CURRENT_EXTENSION_STORE_LISTING.label)}
                  </span>
                </div>
                <Button asChild variant="outline" className="shrink-0">
                  <a
                    href={CURRENT_EXTENSION_STORE_LISTING.ratingUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={markStoreRatingOpened}
                  >
                    <Heart data-icon className="fill-current text-favorite" aria-hidden="true" />
                    {m.options.storeRatingManualAction(CURRENT_EXTENSION_STORE_LISTING.label)}
                    <ExternalLink data-icon aria-hidden="true" />
                  </a>
                </Button>
              </div>

              {storeRatingMessage && (
                <StatusNotice
                  message={storeRatingMessage}
                  testId="store-rating-status"
                />
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
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
