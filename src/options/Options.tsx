import { useEffect, useState } from "react";
import {
  Sun,
  Moon,
  Star,
  Check,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { authStore, CONFIG_STORAGE_KEY } from "@/auth/auth-store";
import {
  bgCall,
  mergeProgressStatus,
  mergeStatusSnapshot,
  onProgress,
  type SyncStatus,
} from "@/utils/messaging";
import { translateError } from "@/api/errors";
import { Button } from "@/ui/shadcn/button";
import { Progress } from "@/ui/shadcn/progress";
import { Spinner } from "@/ui/shadcn/spinner";
import { Textarea } from "@/ui/shadcn/textarea";
import { Separator } from "@/ui/shadcn/separator";
import { Input } from "@/ui/shadcn/input";
import { Checkbox } from "@/ui/shadcn/checkbox";
import { cn } from "@/lib/utils";
import { REPO_URL } from "@/lib/links";
import { useImeBufferedInput } from "@/ui/hooks/use-ime-input";
import { useI18n } from "@/i18n";
import {
  MAX_AUTO_TAG_LIMIT,
  MIN_AUTO_TAG_LIMIT,
  normalizeAutoTagLimit,
} from "@/preferences";

const tutorialNewToken = "/tutorial/img_01.png";
const tutorialRepoAccess = "/tutorial/img_02.png";
const tutorialPermissions = "/tutorial/img_03.png";

export function Options() {
  const [username, setUsername] = useState<string | null>(null);
  const [hasUsableToken, setHasUsableToken] = useState(false);
  const [gistId, setGistId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [autoTagLimit, setAutoTagLimit] = useState<string>("5");
  const [starsPanelDefaultEnabled, setStarsPanelDefaultEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const { locale, setLocale, m } = useI18n();
  const tokenInput = useImeBufferedInput("");

  const refresh = async () => {
    const [c, hasToken, status] = await Promise.all([
      authStore.getConfig(),
      authStore.hasToken(),
      bgCall<SyncStatus>("getStatus").catch(() => null),
    ]);
    setUsername(c.username);
    setHasUsableToken(hasToken);
    setGistId(c.gistId);
    setTheme(c.theme);
    setAutoTagLimit(String(c.autoTagLimit));
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

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { username: u } = await authStore.setToken(tokenInput.value);
      setMsg({ kind: "ok", text: m.options.tokenVerified(u) });
      tokenInput.commit("");
      await refresh();
    } catch (e) {
      setMsg({ kind: "err", text: translateError(e, m) });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
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

  const saveAutoTagLimit = async (raw: string) => {
    const next = normalizeAutoTagLimit(raw);
    setAutoTagLimit(String(next)); // clamp the field back to a legal value
    await authStore.update({ autoTagLimit: next });
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

  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local" || !changes[CONFIG_STORAGE_KEY]) return;
      const oldCfg = changes[CONFIG_STORAGE_KEY].oldValue as Record<string, unknown> | undefined;
      const newCfg = changes[CONFIG_STORAGE_KEY].newValue as Record<string, unknown> | undefined;
      if (
        oldCfg?.username === newCfg?.username &&
        oldCfg?.gistId === newCfg?.gistId &&
        oldCfg?.theme === newCfg?.theme &&
        oldCfg?.locale === newCfg?.locale &&
        oldCfg?.tokenEncrypted === newCfg?.tokenEncrypted
      ) return;
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
                    active
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
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
        <h2 className="text-base font-medium">{m.options.tokenHeading}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          {m.options.tokenIntroPrefix}{" "}
          <a
            className="text-primary hover:underline"
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noreferrer"
          >
            {m.options.tokenLinkLabel}
          </a>
          . {m.options.tokenIntroSuffix}
        </p>

        {/* Detailed PAT walkthrough with tutorial screenshots. Captions live in i18n. */}
        <details className="mt-3 rounded-md border border-border bg-muted/20 p-3 text-[13px] text-muted-foreground">
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

        <ul className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          <li>{m.options.tokenPublicRepos}</li>
          <li>{m.options.tokenGists}</li>
        </ul>
        <p className="mt-1 text-xs text-warning">{m.options.tokenGistNote}</p>

        {hasUsableToken && username && (
          <div className="my-3 flex items-center gap-1.5 text-[13px] text-success">
            <Check className="size-4 shrink-0" />
            <span>{m.options.authenticatedAs(username)}</span>
            <Button variant="ghost" size="sm" className="ml-2" onClick={clear}>
              {m.options.removeToken}
            </Button>
          </div>
        )}
        {!hasUsableToken && username && (
          <div className="my-3 flex items-center gap-1.5 text-[13px] text-warning">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{m.options.cachedAccountWarning(username)}</span>
            <Button variant="ghost" size="sm" className="ml-2" onClick={clear}>
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
          <Button disabled={busy || !tokenInput.value.trim()} onClick={save}>
            {busy ? (
              <>
                <Spinner data-icon="inline-start" />
                {m.options.verifying}
              </>
            ) : (
              m.options.saveVerify
            )}
          </Button>
        </div>
      </section>

      <Separator className="my-6" />

      {/* 2. Gist */}
      <section>
        <h2 className="text-base font-medium">{m.options.gistHeading}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
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
              <span className="min-w-[48px] text-right tabular-nums text-foreground">
                {progressCount}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* 3. Preference */}
      <section className="mt-6">
        <h2 className="text-base font-medium">{m.options.behaviorHeading}</h2>
        <div className="mt-3 grid gap-4 rounded-lg border border-border bg-muted/20 p-4">
          <div className="grid gap-1.5">
            <label
              htmlFor="auto-tag-limit"
              className="text-sm font-medium text-foreground"
            >
              {m.options.autoTagLimitLabel}
            </label>
            <p
              id="auto-tag-limit-hint"
              className="text-[13px] leading-relaxed text-muted-foreground"
            >
              {m.options.autoTagLimitHint}
            </p>
            <div className="flex items-center gap-3">
              <Input
                id="auto-tag-limit"
                type="number"
                min={MIN_AUTO_TAG_LIMIT}
                max={MAX_AUTO_TAG_LIMIT}
                step={1}
                value={autoTagLimit}
                aria-describedby="auto-tag-limit-hint"
                onChange={(e) => setAutoTagLimit(e.currentTarget.value)}
                onBlur={(e) => void saveAutoTagLimit(e.currentTarget.value)}
                className="w-24"
              />
              <span
                id="auto-tag-limit-range"
                className="text-xs text-muted-foreground"
                aria-hidden="true"
              >
                {MIN_AUTO_TAG_LIMIT}–{MAX_AUTO_TAG_LIMIT}
              </span>
            </div>
          </div>

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
                className="text-[13px] leading-relaxed text-muted-foreground"
              >
                {m.options.starsPanelDefaultHint}
              </span>
            </label>
          </div>
        </div>
      </section>

      {msg && (
        <div
          className={cn(
            "mt-4 text-[13px]",
            msg.kind === "ok" ? "text-success" : "text-destructive",
          )}
        >
          {msg.text}
        </div>
      )}
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
      <figcaption className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}
