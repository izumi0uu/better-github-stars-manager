#!/usr/bin/env node
import { deleteSyncGists, listSyncGists } from './gist-sync-admin.mjs';

const token = process.env.GH_TOKEN;
if (!token) {
  console.error('❌ Set GH_TOKEN first: GH_TOKEN=<pat> node tests/manual/ops/reset-gist-sync.mjs');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const gistId = process.argv.find((arg) => arg.startsWith('--gist-id='))?.slice('--gist-id='.length) ?? null;

try {
  if (dryRun) {
    const gists = await listSyncGists(token);
    console.log(`Found ${gists.length} sync gist(s)`);
    for (const gist of gists) {
      console.log(` - ${gist.id} ${gist.html_url ?? ''}`.trim());
    }
    process.exit(0);
  }

  const removed = await deleteSyncGists(token, {
    gistId,
    log: (line) => console.log(line),
  });
  console.log(`✅ Removed ${removed.length} sync gist(s)`);
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
