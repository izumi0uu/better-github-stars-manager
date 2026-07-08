import type { GistPayload } from '@/types';
import { GIST_FILENAME } from '@/sync/gist-contract';

const API = 'https://api.github.com';
const MAX_DISCOVERY_PAGES = 10;

type FetchLike = typeof fetch;

type ListedGist = {
  id?: unknown;
  files?: Record<string, unknown>;
};

type GistDetail = {
  files?: Record<string, { content?: unknown }>;
};

type Candidate = {
  id: string;
  exportedAt: string;
};

export type GistDiscoveryResult =
  | { status: 'found'; id: string; exportedAt: string }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSyncGist(gist: ListedGist): gist is ListedGist & { id: string } {
  return typeof gist.id === 'string' && Boolean(gist.files?.[GIST_FILENAME]);
}

function exportedAtFromPayload(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const v = value.v;
  if (v !== 1 && v !== 2) return null;
  if (typeof value.exportedAt !== 'string') return null;
  if (!isRecord(value.tags) || !isRecord(value.tagMeta)) return null;
  return value.exportedAt;
}

async function readCandidate(
  token: string,
  id: string,
  fetchImpl: FetchLike,
): Promise<Candidate | 'missing' | 'unavailable'> {
  let res: Response;
  try {
    res = await fetchImpl(`${API}/gists/${id}`, {
      headers: authHeaders(token),
      cache: 'no-store',
    });
  } catch {
    return 'unavailable';
  }
  if (res.status === 404) return 'missing';
  if (!res.ok) return 'unavailable';

  let detail: GistDetail;
  try {
    detail = (await res.json()) as GistDetail;
  } catch {
    return 'unavailable';
  }
  const content = detail.files?.[GIST_FILENAME]?.content;
  if (typeof content !== 'string') return 'missing';
  try {
    const exportedAt = exportedAtFromPayload(JSON.parse(content) as GistPayload);
    return exportedAt ? { id, exportedAt } : 'missing';
  } catch {
    return 'missing';
  }
}

export async function discoverExistingSyncGist(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<GistDiscoveryResult> {
  let best: Candidate | null = null;

  for (let page = 1; page <= MAX_DISCOVERY_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchImpl(`${API}/gists?per_page=100&page=${page}`, {
        headers: authHeaders(token),
        cache: 'no-store',
      });
    } catch {
      return { status: 'unavailable', reason: 'network' };
    }
    if (!res.ok) return { status: 'unavailable', reason: `list:${res.status}` };

    let gists: unknown;
    try {
      gists = await res.json();
    } catch {
      return { status: 'unavailable', reason: 'list-json' };
    }
    if (!Array.isArray(gists)) return { status: 'unavailable', reason: 'list-shape' };

    for (const gist of gists as ListedGist[]) {
      if (!isSyncGist(gist)) continue;
      const candidate = await readCandidate(token, gist.id, fetchImpl);
      if (candidate === 'unavailable') return { status: 'unavailable', reason: `read:${gist.id}` };
      if (candidate !== 'missing' && (!best || candidate.exportedAt > best.exportedAt)) {
        best = candidate;
      }
    }

    if (gists.length < 100) break;
  }

  return best ? { status: 'found', id: best.id, exportedAt: best.exportedAt } : { status: 'none' };
}
