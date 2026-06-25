// Regression: the star+json response nests repo in a .repo object; old code read
// item.full_name (undefined) and produced broken IDB keys.
//
// Run: pnpm exec tsx tests/shape.test.ts
import { toStar } from '../src/api/github-star-source';

const pass: string[] = [];
const fail: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}
function assert(c: unknown, msg: string) { if (!c) throw new Error(msg); }

// Real shape from the GitHub API (captured via curl).
const payload = {
  starred_at: '2026-06-22T03:21:01Z',
  repo: {
    full_name: 'alchaincyf/loop-engineering-orange-book',
    html_url: 'https://github.com/alchaincyf/loop-engineering-orange-book',
    description: 'A book',
    language: 'TypeScript',
    stargazers_count: 42,
    topics: ['ai', 'loop'],
    pushed_at: '2026-06-20T00:00:00Z',
    fork: false,
    archived: false,
  },
};

console.log('Payload shape regression (nested repo):');
test('toStar extracts full_name from nested repo (not undefined)', () => {
  const star = toStar(payload as never);
  assert(star.full_name === 'alchaincyf/loop-engineering-orange-book', `full_name was: ${star.full_name}`);
});
test('toStar extracts starred_at from the top level', () => {
  const star = toStar(payload as never);
  assert(star.starred_at === '2026-06-22T03:21:01Z', `starred_at was: ${star.starred_at}`);
});
test('toStar maps all repo fields + sets tombstone=false', () => {
  const star = toStar(payload as never);
  assert(star.language === 'TypeScript', 'language');
  assert(star.stargazers_count === 42, 'stars');
  assert(star.topics.length === 2, 'topics');
  assert(star.tombstone === false, 'tombstone default');
  assert(typeof star.synced_at === 'string' && star.synced_at.length > 0, 'synced_at set');
});
test('full_name is a valid IDB key (string, non-empty)', () => {
  const star = toStar(payload as never);
  assert(typeof star.full_name === 'string' && star.full_name.length > 0, 'not a valid key');
});

console.log(fail.length ? `\n❌ ${fail.length} FAILED` : '\n✅ All shape tests passed');
process.exit(fail.length ? 1 : 0);
