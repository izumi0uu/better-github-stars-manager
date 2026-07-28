import { useEffect, useState } from 'react';
import { Star, Plug, FlaskConical } from 'lucide-react';
import { bgCall, mergeProgressStatus, mergeStatusSnapshot, onProgress, type SyncStatus } from '@/utils/messaging';
import { DEV } from '@/dev';
import { Button } from '@/ui/shadcn/button';
import { Progress } from '@/ui/shadcn/progress';
import { Separator } from '@/ui/shadcn/separator';
import { Spinner } from '@/ui/shadcn/spinner';
import { REPO_URL } from '@/lib/links';
import { useI18n } from '@/i18n';
import { getAgentDiagnosticsMessages } from '@/dev-agent/messages';

interface ConnResult {
  status: number;
  statusText: string;
  remaining: string | null;
  limit: string | null;
  scopes: string | null;
  itemCount: number;
  sample: string | null;
}

export function Popup() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [connResult, setConnResult] = useState<string | null>(null);
  const { locale, m } = useI18n();

  const refresh = () =>
    bgCall<SyncStatus>('getStatus')
      .then((next) => setStatus((current) => mergeStatusSnapshot(current, next)))
      .catch(() => {});

  useEffect(() => {
    refresh();
    const off = onProgress((progress) => {
      setStatus((current) => mergeProgressStatus(current, progress));
    });
    return off;
  }, []);

  const run = async (type: string, label: string) => {
    setPendingAction(type);
    setErr(null);
    try {
      await bgCall(type);
      await refresh();
    } catch (e) {
      setErr(m.popup.failed(label, e instanceof Error ? e.message : String(e)));
    } finally {
      setPendingAction((cur) => (cur === type ? null : cur));
    }
  };

  const openStars = async () => {
    const u = await bgCall<{ username: string | null }>('getUsername');
    chrome.tabs.create({ url: u.username ? `https://github.com/${u.username}?tab=stars` : 'https://github.com/stars' });
  };

  const openOptions = () => chrome.runtime.openOptionsPage();

  const testConn = async () => {
    setPendingAction('testConnection');
    setConnResult(m.popup.testing);
    try {
      const r = await bgCall<ConnResult>('testConnection');
      let text =
        `HTTP ${r.status} ${r.statusText}\n` +
        `${m.popup.rate(r.remaining, r.limit)}\n` +
        `${m.popup.scopes(r.scopes)}\n` +
        `${m.popup.itemsOnPage(r.itemCount)}\n` +
        `${m.popup.sample(r.sample)}`;
      if (r.status === 200 && r.itemCount > 0) text = `${m.popup.connectionOk}\n${text}`;
      else if (r.status === 204) text = `${m.popup.connectionNoContent}\n${text}`;
      else if (r.status === 401) text = `${m.popup.connectionRejected}\n${text}`;
      else if (r.status === 403) text = `${m.popup.connectionForbidden}\n${text}`;
      setConnResult(text);
    } catch (e) {
      setConnResult(`${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPendingAction((cur) => (cur === 'testConnection' ? null : cur));
    }
  };

  const openDiagnostics = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dev-agent/index.html') });
  };

  const p = status?.progress;
  const hasToken = status?.hasToken;
  const syncing = !!(status?.inFlight && p && p.phase !== 'idle');
  const actionBusy = syncing || pendingAction !== null;
  const progressValue = p?.total ? Math.max(1, Math.min(100, Math.round((p.done / p.total) * 100))) : null;
  const progressCount = p?.total ? `${p.done}/${p.total}` : null;
  const buttonLabel = (label: string, active: boolean, icon?: React.ReactNode) =>
    active ? (
      <>
        <Spinner data-icon="inline-start" />
        {label}
        {progressCount && <span className="gsm-inline-progress-count">{progressCount}</span>}
      </>
    ) : (
      <>
        {icon}
        {label}
      </>
    );

  return (
    <div className="flex min-w-[280px] flex-col gap-2 p-3 font-sans">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 inline-flex items-center gap-1.5 text-[15px] font-semibold text-foreground">
          <Star className="size-4 fill-current text-primary" />
          {m.popup.title}
        </h2>
        <Button asChild variant="ghost" size="icon" title={m.popup.starRepoTitle}>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            <Star className="size-4" />
          </a>
        </Button>
      </div>

      {!hasToken && (
        <div className="gsm-status-note flex items-center gap-2 text-warning">
          {m.popup.noToken}
          <Button variant="outline" size="sm" onClick={openOptions}>{m.popup.addPat}</Button>
        </div>
      )}

      <div className="flex min-h-[18px] flex-col gap-1 text-xs text-muted-foreground">
        <div className="inline-flex items-center gap-2">
          {syncing && <Spinner className="size-3" />}
          {p
            ? `${syncing ? `${m.common.phase(p.phase)}: ` : ''}${p.message || m.popup.idle}`
            : m.popup.idle}
        </div>
        {syncing && progressValue != null && (
          <div className="flex items-center gap-2">
            <Progress value={progressValue} className="h-2 flex-1" />
            <span className="gsm-progress-count">{progressCount}</span>
          </div>
        )}
      </div>

      <div className="grid gap-1.5">
        <Button variant="outline" disabled={actionBusy || !hasToken} onClick={() => void run('syncIncremental', m.popup.syncIncremental)}>
          {buttonLabel(m.popup.syncIncremental, pendingAction === 'syncIncremental')}
        </Button>
        <Button variant="outline" disabled={actionBusy || !hasToken} onClick={() => void run('syncFull', m.popup.syncFull)}>
          {buttonLabel(m.popup.syncFull, pendingAction === 'syncFull')}
        </Button>
        <Button variant="outline" disabled={actionBusy || !hasToken} onClick={() => void run('syncRescan', m.popup.reconcile)}>
          {buttonLabel(m.popup.reconcile, pendingAction === 'syncRescan')}
        </Button>
        <Button variant="outline" disabled={actionBusy || !hasToken} onClick={() => void run('gistPull', m.popup.gistPull)}>
          {buttonLabel(m.popup.gistPull, pendingAction === 'gistPull')}
        </Button>
        <Button variant="outline" disabled={actionBusy || !hasToken} onClick={() => void run('gistPush', m.popup.gistPush)}>
          {buttonLabel(m.popup.gistPush, pendingAction === 'gistPush')}
        </Button>
        <Separator className="my-1" />
        <Button onClick={() => void testConn()} disabled={actionBusy}>{buttonLabel(m.popup.testConnection, pendingAction === 'testConnection', <Plug className="size-4" data-icon="inline-start" />)}</Button>
        {connResult && (
          <pre className="gsm-scrollbar-stable m-0 max-h-[150px] overflow-auto rounded border border-border bg-muted/40 p-1.5 text-[10px] text-foreground whitespace-pre-wrap">
            {connResult}
          </pre>
        )}
        {DEV && (
          <Button
            variant="outline"
            size="icon"
            title={getAgentDiagnosticsMessages(locale).openAgentDiagnostics}
            aria-label={getAgentDiagnosticsMessages(locale).openAgentDiagnostics}
            onClick={openDiagnostics}
          >
            <FlaskConical className="size-4" />
          </Button>
        )}
        <Separator className="my-1" />
        <Button variant="ghost" onClick={openStars}>{m.popup.openStars}</Button>
        <Button variant="ghost" onClick={openOptions}>{m.popup.options}</Button>
      </div>

      {err && <div className="mt-1 text-[11px] text-destructive">{err}</div>}
    </div>
  );
}
