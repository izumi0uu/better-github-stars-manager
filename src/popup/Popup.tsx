import { useEffect, useState } from 'react';
import { bgCall, onProgress, type SyncStatus } from '@/utils/messaging';

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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [connResult, setConnResult] = useState<string | null>(null);

  const refresh = () => bgCall<SyncStatus>('getStatus').then(setStatus).catch(() => {});

  useEffect(() => {
    refresh();
    const off = onProgress(() => refresh());
    return off;
  }, []);

  const run = async (type: string, label: string) => {
    setBusy(true);
    setErr(null);
    try {
      await bgCall(type);
      await refresh();
    } catch (e) {
      setErr(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const openStars = async () => {
    const u = await bgCall<{ username: string | null }>('getUsername');
    if (u.username) {
      chrome.tabs.create({ url: `https://github.com/${u.username}?tab=stars` });
    } else {
      chrome.tabs.create({ url: 'https://github.com/stars' });
    }
  };

  const openOptions = () => chrome.runtime.openOptionsPage();

  const testConn = async () => {
    setBusy(true);
    setConnResult('testing…');
    try {
      const r = await bgCall<ConnResult>('testConnection');
      let text =
        `HTTP ${r.status} ${r.statusText}\n` +
        `rate: ${r.remaining}/${r.limit} remaining\n` +
        `scopes: ${r.scopes ?? '(fine-grained: none shown)'}\n` +
        `items on page 1: ${r.itemCount}\n` +
        `sample: ${r.sample ?? '—'}`;
      if (r.status === 200 && r.itemCount > 0) text = `✅ OK — connection works\n${text}`;
      else if (r.status === 204) text = `⚠️ 204 No Content — token may lack /user/starred access\n${text}`;
      else if (r.status === 401) text = `❌ 401 — token rejected\n${text}`;
      else if (r.status === 403) text = `❌ 403 — forbidden (check scopes / repository access)\n${text}`;
      setConnResult(text);
    } catch (e) {
      setConnResult(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const p = status?.progress;
  const hasToken = status?.hasToken;

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', minWidth: 280 }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>⭐ GitHub Stars Manager</h2>

      {!hasToken && (
        <div style={{ fontSize: 13, color: '#d29922', marginBottom: 10 }}>
          No token configured.
          <button onClick={openOptions} style={{ marginLeft: 6 }}>
            Add PAT
          </button>
        </div>
      )}

      <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, minHeight: 18 }}>
        {p && p.phase !== 'idle' ? `${p.phase}: ${p.message}` : p?.message || 'Idle'}
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <button disabled={busy || !hasToken} onClick={() => run('syncIncremental', 'Incremental sync')}>
          Sync new stars (incremental)
        </button>
        <button disabled={busy || !hasToken} onClick={() => run('syncFull', 'Full sync')}>
          Full re-pull all stars
        </button>
        <button disabled={busy || !hasToken} onClick={() => run('syncRescan', 'Rescan')}>
          Detect unstars (rescan)
        </button>
        <button disabled={busy || !hasToken} onClick={() => run('gistPull', 'Gist pull')}>
          Pull tags from Gist
        </button>
        <button disabled={busy || !hasToken} onClick={() => run('gistPush', 'Gist push')}>
          Push tags to Gist
        </button>
        <hr style={{ border: 0, borderTop: '1px solid #30363d', margin: '4px 0' }} />
        <button onClick={testConn} disabled={busy}>
          🔌 Test GitHub connection
        </button>
        {connResult && (
          <pre
            style={{
              fontSize: 10,
              color: '#79c0ff',
              background: '#161b22',
              padding: 6,
              borderRadius: 4,
              margin: '4px 0',
              whiteSpace: 'pre-wrap',
              maxHeight: 150,
              overflow: 'auto',
            }}
          >
            {connResult}
          </pre>
        )}
        <button onClick={openStars}>Open my stars page</button>
        <button onClick={openOptions}>Options…</button>
      </div>

      {err && <div style={{ fontSize: 11, color: '#f85149', marginTop: 8 }}>{err}</div>}
    </div>
  );
}
