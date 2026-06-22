import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStars } from '@/ui/use-stars';
import { useFilterStore } from '@/ui/filter-store';
import { StarRow } from '@/ui/components/StarRow';
import { suggestTags } from '@/ui/suggest';
import { bgCall, onProgress, type SyncStatus } from '@/utils/messaging';

const ROW_HEIGHT = 40;

export function ManagerPanel() {
  const { rows, total, grandTotal, loading, languages, tagTree, tagsByFullName } = useStars();
  const f = useFilterStore();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Read initial tag filter from URL hash (D4 chip click → #gsm-tag=xxx).
  useEffect(() => {
    const m = location.hash.match(/gsm-tag=([^&]+)/);
    if (m) {
      f.toggleTag(decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount: read status first. Only auto-sync if a token is configured; if not,
  // surface a clear "configure token" prompt instead of silently failing.
  useEffect(() => {
    let off = () => {};
    (async () => {
      const st = await bgCall<SyncStatus>('getStatus').catch(() => null);
      setStatus(st);
      if (st?.hasToken) {
        // Token present → kick incremental sync. Surface errors (don't swallow).
        bgCall('syncIncremental').catch(
          (e) => setInfo(`✗ sync: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      off = onProgress(() => bgCall<SyncStatus>('getStatus').then(setStatus));
    })();
    return () => off();
  }, []);

  // Keyboard shortcut: / focus search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const doSync = async (type: string, label: string) => {
    setBusy(true);
    setInfo(null);
    try {
      const r = await bgCall<Record<string, number>>(type);
      setInfo(`${label}: ${JSON.stringify(r)}`);
    } catch (e) {
      setInfo(`✗ ${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const batchSuggest = async () => {
    // Build suggestions client-side from the rows we have, send one batch message.
    const items = rows
      .map((star) => {
        const existing = tagsByFullName.get(star.full_name)?.tags ?? [];
        const toAdd = suggestTags(star, existing);
        return toAdd.length ? { full_name: star.full_name, toAdd } : null;
      })
      .filter((x): x is { full_name: string; toAdd: string[] } => x !== null);
    if (items.length === 0) {
      setInfo('Nothing new to auto-tag');
      return;
    }
    setBusy(true);
    try {
      const r = await bgCall<{ count: number }>('acceptSuggestionsBatch', { items });
      setInfo(`Auto-tagged ${r.count} repos from language/topics`);
    } catch (e) {
      setInfo(`✗ auto-tag: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d1117', color: '#c9d1d9', fontFamily: 'system-ui, sans-serif' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderBottom: '1px solid #30363d', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          ref={searchRef}
          placeholder="Search name/desc/topics…  (press /)"
          value={f.query}
          onChange={(e) => f.setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: '4px 8px', background: '#161b22', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: 4 }}
        />
        <select value={f.sortKey} onChange={(e) => f.setSort(e.target.value as typeof f.sortKey)} style={selectStyle}>
          <option value="starred_at">Sort: starred</option>
          <option value="pushed_at">Sort: updated</option>
          <option value="stargazers_count">Sort: stars</option>
          <option value="name">Sort: name</option>
        </select>
        <button onClick={() => f.setSort(f.sortKey, f.sortDir === 'asc' ? 'desc' : 'asc')} style={btnStyle} title="Toggle direction">
          {f.sortDir === 'asc' ? '↑' : '↓'}
        </button>
        <label style={{ fontSize: 12, color: '#8b949e' }}>
          <input type="checkbox" checked={f.onlyUntagged} onChange={(e) => f.setOnlyUntagged(e.target.checked)} /> untagged
        </label>
        <label style={{ fontSize: 12, color: '#8b949e' }}>
          <input type="checkbox" checked={f.showTombstone} onChange={(e) => f.setShowTombstone(e.target.checked)} /> unstarred
        </label>
        <button onClick={batchSuggest} disabled={busy} style={btnStyle} title="Auto-tag filtered repos from language/topics">⚡ Auto-tag</button>
        <button onClick={() => doSync('syncIncremental', 'incremental')} disabled={busy} style={btnStyle}>↻ Sync</button>
        <button onClick={() => doSync('syncRescan', 'rescan')} disabled={busy} style={btnStyle} title="Detect unstars">⟲ Rescan</button>
        <button onClick={() => doSync('gistPush', 'gist push')} disabled={busy} style={btnStyle}>⬆ Push</button>
        <button onClick={() => doSync('gistPull', 'gist pull')} disabled={busy} style={btnStyle}>⬇ Pull</button>
        <span style={{ fontSize: 11, color: '#6e7681' }}>
          {loading ? '…' : `${total} / ${grandTotal}`}
        </span>
      </div>

      {status && !status.hasToken && (
        <div style={{ fontSize: 12, padding: '8px 12px', background: '#2d1b00', color: '#d29922', display: 'flex', gap: 12, alignItems: 'center' }}>
          <span>⚠️ No GitHub token configured — no data will load.</span>
          <button onClick={() => chrome.runtime.openOptionsPage()} style={{ ...btnStyle, background: '#238636', color: '#fff' }}>
            Open Options to add a PAT
          </button>
        </div>
      )}

      {status?.progress && status.progress.phase !== 'idle' && (
        <div style={{ fontSize: 11, padding: '2px 12px', background: '#161b22', color: '#79c0ff' }}>
          {status.progress.phase}: {status.progress.message}
        </div>
      )}
      {info && <div style={{ fontSize: 11, padding: '2px 12px', color: '#8b949e' }}>{info}</div>}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left sidebar: languages + tag tree */}
        <div style={{ width: 200, borderRight: '1px solid #30363d', overflow: 'auto', padding: 8, fontSize: 12 }}>
          <div style={{ color: '#8b949e', marginBottom: 4 }}>Languages</div>
          {languages.slice(0, 30).map(([lang, count]) => (
            <label key={lang} style={{ display: 'block', color: f.languages.includes(lang) ? '#79c0ff' : '#c9d1d9' }}>
              <input type="checkbox" checked={f.languages.includes(lang)} onChange={() => f.toggleLanguage(lang)} /> {lang} ({count})
            </label>
          ))}
          <div style={{ color: '#8b949e', margin: '12px 0 4px' }}>Tags ({tagTree.total})</div>
          {[...tagTree.grouped.entries()].map(([dim, tags]) => (
            <div key={dim ?? '__none'} style={{ marginBottom: 6 }}>
              {dim && <div style={{ color: '#6e7681', fontSize: 10, textTransform: 'uppercase' }}>{dim}</div>}
              {tags.map(({ name, count }) => (
                <label key={name} style={{ display: 'block', color: f.tags.includes(name) ? '#79c0ff' : '#c9d1d9' }}>
                  <input type="checkbox" checked={f.tags.includes(name)} onChange={() => f.toggleTag(name)} /> {name} ({count})
                </label>
              ))}
            </div>
          ))}
        </div>

        {/* Virtual list */}
        <div ref={listRef} style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,1.6fr) 2fr 90px 70px 120px 1.4fr 28px', gap: 10, padding: '6px 12px', borderBottom: '1px solid #30363d', fontSize: 11, color: '#6e7681', position: 'sticky', top: 0, background: '#0d1117', zIndex: 1 }}>
            <span>Repository</span><span>Description</span><span>Lang</span><span>Stars</span><span>Updated</span><span>Tags</span><span></span>
          </div>
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const star = rows[vi.index];
              return (
                <div
                  key={star.full_name}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                >
                  <StarRow star={star} tag={tagsByFullName.get(star.full_name)} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  font: '12px system-ui',
  padding: '3px 8px',
  background: '#21262d',
  color: '#c9d1d9',
  border: '1px solid #30363d',
  borderRadius: 4,
  cursor: 'pointer',
};
const selectStyle: React.CSSProperties = { ...btnStyle, padding: '2px 6px' };
