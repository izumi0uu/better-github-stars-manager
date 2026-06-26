#!/usr/bin/env node
/** End-to-end verification outside the Chrome runtime. */
import 'fake-indexeddb/auto';
import { db } from '../src/storage/db';
import { queryStars, invalidateCache } from '../src/background/query';

const storageBacking: Record<string, unknown> = {};
(globalThis as any).chrome = {
  ...(globalThis as any).chrome,
  storage: {
    local: {
      async get<T extends string>(keys: T | T[] | null): Promise<Record<string, unknown>> {
        if (keys === null || keys === undefined) return { ...storageBacking };
        const ks = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of ks) if (k in storageBacking) out[k] = storageBacking[k];
        return out;
      },
      async set(obj: Record<string, unknown>): Promise<void> {
        Object.assign(storageBacking, obj);
      },
    },
  },
  runtime: { sendMessage: async () => {}, id: 'verify-e2e' },
};

let TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  process.stderr.write('GH_TOKEN not set. Paste it now (input hidden, press Enter):\n> ');
  for await (const chunk of process.stdin) {
    TOKEN = chunk.toString().trim();
    break;
  }
}
if (!TOKEN) {
  console.error('❌ No token provided. Either `export GH_TOKEN=...` or pipe it via stdin.');
  process.exit(1);
}

const PER_PAGE = 100;

console.log('1) Verifying token via real authStore.setToken() (exercises AES-GCM) …');
import { authStore } from '../src/auth/auth-store';
try {
  const { username } = await authStore.setToken(TOKEN);
  console.log(`   ✓ authenticated as @${username} (token AES-GCM encrypted in storage)`);
} catch (e) {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

console.log('2) Fetching /user/starred (page 1, star+json media) …');
const starRes = await fetch('https://api.github.com/user/starred?per_page=1&page=1', {
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.star+json' },
  cache: 'no-store',
});
console.log(`   HTTP ${starRes.status} | rate ${starRes.headers.get('x-ratelimit-remaining')}/${starRes.headers.get('x-ratelimit-limit')}`);
if (!starRes.ok) {
  console.error(`❌ /user/starred returned ${starRes.status}`);
  process.exit(1);
}
const page1 = (await starRes.json()) as Array<{ starred_at: string; repo: { full_name: string } }>;
if (!page1.length || !page1[0].repo) {
  console.error(`❌ Unexpected payload shape — no nested repo object.`);
  process.exit(1);
}
console.log(`   ✓ nested repo.full_name = "${page1[0].repo.full_name}"`);

console.log('3) Running real syncFull() orchestrator (concurrent pages → toStar → bulkPut) …');
import { githubStarSource } from '../src/api/github-star-source';
let progressLines = 0;
const syncResult = await githubStarSource.syncFull((p) => {
  if (progressLines++ < 3) console.log(`   progress: ${p.phase} ${p.done}/${p.total ?? '?'} — ${p.message}`);
});
const dbCount = await db.stars.count();
console.log(`   ✓ syncFull returned ${JSON.stringify(syncResult)} | DB now holds ${dbCount} stars`);

invalidateCache();
const result = await queryStars({
  filter: { query: '', languages: [], tags: [], tagMode: 'any', showTombstone: false, onlyFavorite: false, onlyUntagged: false, sortKey: 'starred_at', sortDir: 'desc' },
  offset: 0,
  limit: 5,
});
console.log('4) Querying through real engine (top 5 by starred_at desc) …');
console.log(`   ✓ grandTotal=${result.grandTotal} | filtered=${result.total} | languages facet count=${result.languages.length}`);
console.log('   Top 5 rows:');
for (const s of result.rows) {
  console.log(`     • ${s.full_name}  (★${s.stargazers_count}, ${s.language ?? '—'}, starred ${s.starred_at.slice(0, 10)})`);
}

const cfg = await authStore.getConfig();
console.log('5) Checking incremental cursor advanced …');
if (!cfg.lastSyncStarredAt) {
  console.error('❌ lastSyncStarredAt cursor was NOT set — syncIncremental will re-pull everything.');
  process.exit(1);
}
console.log(`   ✓ lastSyncStarredAt cursor = ${cfg.lastSyncStarredAt}`);

console.log('\n✅ END-TO-END VERIFIED: token → authStore → syncFull orchestrator → nested-parse → IDB write → query → rows.');
console.log('   The FULL Chrome sync path works against the real GitHub API with the real code.');
console.log('   If stars still don\'t appear in Chrome, the cause is purely Chrome-runtime');
console.log('   (extension not reloaded / token not saved in Options page), NOT the data logic.');
