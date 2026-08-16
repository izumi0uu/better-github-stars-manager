import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ExternalLink, Loader2, RotateCcw, Unplug } from 'lucide-react';
import brandMarkUrl from '@/assets/bgsm-brand-mark.svg?url';
import { demoCopyFor } from '@/demo/demo-copy';
import { useI18n } from '@/i18n';
import { REPO_URL } from '@/lib/links';
import { Button } from '@/ui/shadcn/button';
import './demo-shell.css';

const INSTALL_URL = 'https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa';

type ResetPhase = 'idle' | 'confirming' | 'resetting' | 'error';
type DemoResource = 'install' | 'source' | 'privacy' | 'documentation';

export type DemoShellProps = Readonly<{
  interactiveDemo: ReactNode;
  onReset: () => void | Promise<void>;
  resetEpoch: number;
}>;

function ProductResourceLink({
  href,
  label,
  resource,
  prominent = false,
}: Readonly<{
  href: string;
  label: string;
  resource: DemoResource;
  prominent?: boolean;
}>) {
  return (
    <Button asChild variant={prominent ? 'default' : 'ghost'} size="sm" className="h-8 px-2.5 text-xs">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        data-demo-external-link={resource}
      >
        {label}
        <ExternalLink className="size-3" aria-hidden="true" />
      </a>
    </Button>
  );
}

export function DemoShell({ interactiveDemo, onReset, resetEpoch }: DemoShellProps) {
  const { locale } = useI18n();
  const copy = demoCopyFor(locale).shell;
  const [resetPhase, setResetPhase] = useState<ResetPhase>('idle');
  const confirmResetRef = useRef<HTMLButtonElement | null>(null);
  const resetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const docsLocale = locale === 'zh-CN' ? 'zh' : 'en';
  const privacyUrl = `${REPO_URL}/blob/master/docs/${docsLocale}/privacy-policy.md`;
  const documentationUrl = `${REPO_URL}/tree/master/docs/${docsLocale}`;
  const resetOpen = resetPhase !== 'idle';
  const resetting = resetPhase === 'resetting';

  useEffect(() => {
    setResetPhase('idle');
  }, [resetEpoch]);

  useEffect(() => {
    if (resetPhase === 'confirming' || resetPhase === 'error') {
      confirmResetRef.current?.focus();
    }
  }, [resetPhase]);


  const handleConfirmReset = async () => {
    setResetPhase('resetting');
    try {
      await onReset();
      setResetPhase('idle');
      resetTriggerRef.current?.focus();
    } catch {
      setResetPhase('error');
    }
  };

  return (
    <div
      className="demo-shell-root flex min-w-0 flex-col bg-background text-foreground antialiased"
      data-testid="demo-shell"
      data-demo-locale={locale}
      lang={locale}
    >
      <a
        href="#demo-main"
        className="sr-only z-[var(--gsm-z-overlay)] rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {copy.skipToContent}
      </a>

      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-screen-2xl min-w-0 flex-col gap-3 px-3 py-3 sm:px-5 md:flex-row md:items-center">
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src={brandMarkUrl}
              alt=""
              aria-hidden="true"
              width={128}
              height={128}
              draggable={false}
              className="size-9 shrink-0 object-contain"
              data-product-brand-mark
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight text-foreground">{copy.brandName}</p>
              <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{copy.publicDemo}</p>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center md:ml-auto">

            <Button
              ref={resetTriggerRef}
              type="button"
              variant="outline"
              size="sm"
              className="h-9 shrink-0"
              aria-describedby="demo-reset-hint"
              aria-expanded={resetOpen}
              aria-controls="demo-reset-confirmation"
              disabled={resetting}
              onClick={() => setResetPhase('confirming')}
              data-testid="demo-reset"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {copy.resetDemo}
            </Button>
            <span id="demo-reset-hint" className="sr-only">{copy.resetHint}</span>
          </div>
        </div>
      </header>

      <aside
        className="border-b border-border bg-muted/40"
        aria-label={copy.noticeLabel}
        role="note"
        data-testid="demo-notice"
      >
        <div className="mx-auto flex w-full max-w-screen-2xl min-w-0 items-start gap-2.5 px-3 py-2.5 sm:items-center sm:px-5">
          <Unplug className="mt-0.5 size-4 shrink-0 text-muted-foreground sm:mt-0" aria-hidden="true" />
          <p className="min-w-0 text-xs leading-5 text-muted-foreground">
            <strong className="font-semibold text-foreground">{copy.noticeTitle}.</strong>{' '}
            {copy.noticeBody}
          </p>
        </div>
      </aside>

      {resetOpen && (
        <div className="border-b border-border bg-card" aria-live="polite">
          <section
            id="demo-reset-confirmation"
            className="mx-auto flex w-full max-w-screen-2xl min-w-0 flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:px-5"
            aria-labelledby="demo-reset-confirmation-title"
            aria-describedby="demo-reset-confirmation-body"
            aria-busy={resetting}
            data-testid="demo-reset-confirmation"
          >
            <div className="min-w-0 flex-1">
              <h2 id="demo-reset-confirmation-title" className="text-sm font-semibold text-foreground">
                {copy.resetConfirmTitle}
              </h2>
              <p id="demo-reset-confirmation-body" className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {copy.resetConfirmBody}
              </p>
              {resetPhase === 'error' && (
                <p role="alert" className="mt-1 text-xs font-medium text-destructive">
                  {copy.resetFailed}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                ref={confirmResetRef}
                type="button"
                size="sm"
                disabled={resetting}
                onClick={() => { void handleConfirmReset(); }}
                data-testid="demo-reset-confirm"
              >
                {resetting && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {resetting ? copy.resetting : copy.confirmReset}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={resetting}
                onClick={() => {
                  setResetPhase('idle');
                  resetTriggerRef.current?.focus();
                }}
                data-testid="demo-reset-cancel"
              >
                {copy.cancelReset}
              </Button>
            </div>
          </section>
        </div>
      )}

      <main id="demo-main" className="min-w-0 flex-1" tabIndex={-1}>
        <section
          id="demo-interactive-panel"
          className="mx-auto w-full max-w-screen-2xl min-w-0 px-3 py-4 sm:px-5 sm:py-5"
        >
          <div
            className="demo-interactive-host min-w-0 overflow-hidden rounded-lg border border-border bg-card"
            data-testid="demo-interactive-host"
          >
            {interactiveDemo}
          </div>
        </section>

      </main>

      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex w-full max-w-screen-2xl min-w-0 flex-col gap-2 px-3 py-4 sm:px-5 lg:flex-row lg:items-center">
          <div className="min-w-0 lg:mr-auto">
            <p className="text-xs font-semibold text-foreground">{copy.productLinks}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{copy.productLinksHint}</p>
          </div>
          <nav
            aria-label={copy.resourceNavigation}
            className="flex min-w-0 flex-wrap items-center gap-1"
          >
            <ProductResourceLink
              href={INSTALL_URL}
              label={copy.install}
              resource="install"
              prominent
            />
            <ProductResourceLink href={REPO_URL} label={copy.source} resource="source" />
            <ProductResourceLink href={privacyUrl} label={copy.privacy} resource="privacy" />
            <ProductResourceLink
              href={documentationUrl}
              label={copy.documentation}
              resource="documentation"
            />
          </nav>
        </div>
      </footer>
    </div>
  );
}
