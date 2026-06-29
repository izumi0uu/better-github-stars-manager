const API = 'https://api.github.com';
export const GIST_FILENAME = 'better-github-stars-manager-tags.json';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function expectOk(res, label) {
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  throw new Error(`${label} failed: ${res.status} ${text}`.trim());
}

export async function listSyncGists(token) {
  const found = [];
  for (let page = 1; ; page += 1) {
    const res = await expectOk(
      await fetch(`${API}/gists?per_page=100&page=${page}`, {
        headers: headers(token),
      }),
      `list gists page ${page}`,
    );
    const items = await res.json();
    if (!Array.isArray(items)) {
      throw new Error(`list gists page ${page} returned non-array payload`);
    }

    for (const gist of items) {
      const files = gist?.files ?? {};
      if (!Object.prototype.hasOwnProperty.call(files, GIST_FILENAME)) continue;
      found.push({
        id: gist.id,
        description: gist.description ?? '',
        html_url: gist.html_url ?? null,
      });
    }

    if (items.length < 100) break;
  }
  return found;
}

export async function deleteGistById(token, gistId) {
  const res = await fetch(`${API}/gists/${gistId}`, {
    method: 'DELETE',
    headers: headers(token),
  });
  if (res.status === 204) return;
  const text = await res.text().catch(() => '');
  throw new Error(`delete gist ${gistId} failed: ${res.status} ${text}`.trim());
}

export async function deleteSyncGists(token, options = {}) {
  const { gistId = null, log = () => {} } = options;
  const targets = gistId ? [{ id: gistId, html_url: null }] : await listSyncGists(token);

  for (const gist of targets) {
    log(`   deleting gist ${gist.id}${gist.html_url ? ` (${gist.html_url})` : ''}`);
    await deleteGistById(token, gist.id);
  }

  return targets;
}
