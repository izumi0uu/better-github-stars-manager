import type { ManagerAccount, ManagerPreferences } from '@/runtime/manager-runtime';
import type { Star, Tag, TagMeta } from '@/types';
import type {
  GitHubNotificationThread,
  GitHubWatchStateRecord,
  WatchSubjectDetail,
} from '@/watch/watch-model';
import type { RadarActivityRecord, RadarStateRecord } from '@/radar/radar-model';
import type {
  RecommendationIgnoreRecord,
  RecommendationRecord,
  RecommendationStateRecord,
} from '@/recommendations/recommendation-model';
import avatarAmberUrl from './assets/avatar-amber.svg?url';
import avatarPlumUrl from './assets/avatar-plum.svg?url';
import avatarSkyUrl from './assets/avatar-sky.svg?url';
import avatarSunUrl from './assets/avatar-sun.svg?url';

export const DEMO_BUILD_CANARY = 'bgsm-public-demo-fixture-v1';

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;


export type DemoFixture = DeepReadonly<{
  now: number;
  account: ManagerAccount;
  preferences: ManagerPreferences;
  stars: Star[];
  tags: Tag[];
  tagMeta: TagMeta[];
  watchThreads: GitHubNotificationThread[];
  watchState: GitHubWatchStateRecord;
  watchSubjectDetailsByThreadId: Record<string, WatchSubjectDetail>;
  radarActivities: RadarActivityRecord[];
  radarState: RadarStateRecord;
  recommendationBatches: RecommendationRecord[][];
  recommendationState: RecommendationStateRecord;
  recommendationIgnores: RecommendationIgnoreRecord[];
  avatarAssets: Record<string, string>;
}>;

const FIXED_NOW_ISO = '2026-08-16T12:00:00.000Z';
const FIXED_NOW = Date.parse(FIXED_NOW_ISO);
const DAY = 24 * 60 * 60 * 1_000;
const ACCOUNT_LOGIN = 'demo-scout';

function beforeNow(days: number, hourOffset = 0): string {
  return new Date(FIXED_NOW - days * DAY - hourOffset * 60 * 60 * 1_000).toISOString();
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

const TAG_DEFINITIONS = [
  ['AI', 'topic', '#8b5cf6'],
  ['Frontend', 'stack', '#2563eb'],
  ['Backend', 'stack', '#0891b2'],
  ['Rust', 'language', '#b45309'],
  ['Data', 'topic', '#0f766e'],
  ['DevTools', 'topic', '#475569'],
  ['Learning', 'intent', '#7c3aed'],
  ['Design', 'topic', '#db2777'],
  ['CLI', 'interface', '#4d7c0f'],
  ['Reference', 'intent', '#64748b'],
] as const;

const REPOSITORY_OWNERS = [
  'aurora-workshop',
  'meadow-labs',
  'northwind-studio',
  'paper-kite-dev',
  'quiet-river-code',
  'silver-maple',
  'tiny-orbit-tools',
  ACCOUNT_LOGIN,
] as const;

const REPOSITORY_NAMES = [
  'atlas-notes',
  'beacon-kit',
  'circuit-garden',
  'drift-console',
  'ember-cache',
  'field-guide',
  'harbor-query',
  'lantern-ui',
] as const;

const LANGUAGES = ['TypeScript', 'Rust', 'Python', 'Go', 'Kotlin', 'Swift', 'C++', null] as const;
const TOPICS = [
  ['developer-tools', 'productivity'],
  ['design-systems', 'accessibility'],
  ['data', 'visualization'],
  ['cli', 'automation'],
  ['learning', 'reference'],
  ['frontend', 'components'],
  ['backend', 'observability'],
  ['ai', 'search'],
] as const;

const STARS: Star[] = REPOSITORY_OWNERS.flatMap((owner, ownerIndex) => (
  REPOSITORY_NAMES.map((name, nameIndex) => {
    const index = ownerIndex * REPOSITORY_NAMES.length + nameIndex;
    const tombstone = index === 63;
    const fullName = `${owner}/${name}`;
    return {
      full_name: fullName,
      html_url: '#',
      description: `A fictional ${LANGUAGES[index % LANGUAGES.length] ?? 'multi-language'} project for ${TOPICS[index % TOPICS.length].join(' and ')} workflows.`,
      language: LANGUAGES[index % LANGUAGES.length],
      stargazers_count: 140 + index * 83,
      topics: [...TOPICS[index % TOPICS.length]],
      pushed_at: beforeNow(4 + index),
      created_at: beforeNow(420 + index * 5),
      fork: index === 17 || index === 52,
      archived: index === 11 || index === 38,
      owner_avatar_url: [avatarSunUrl, avatarSkyUrl, avatarPlumUrl, avatarAmberUrl][ownerIndex % 4],
      viewer_has_starred: !tombstone,
      starred_at: beforeNow(45 + index),
      tombstone,
      synced_at: beforeNow(2),
    } satisfies Star;
  })
));

const TAG_META: TagMeta[] = TAG_DEFINITIONS.map(([name, dimension, color]) => ({
  name,
  dimension,
  color,
  mtime: beforeNow(5),
  excluded: false,
}));

const TAGS: Tag[] = STARS.slice(0, 54).map((star, index) => {
  const primary = TAG_DEFINITIONS[index % TAG_DEFINITIONS.length][0];
  const automatic = TAG_DEFINITIONS[(index + 3) % TAG_DEFINITIONS.length][0];
  return {
    full_name: star.full_name,
    manualTags: index % 6 === 5 ? [] : [primary],
    autoTags: index % 3 === 0 ? [automatic] : [],
    dismissedAutoTags: index % 11 === 0 ? ['Reference'] : [],
    manualTagsMtime: beforeNow(12),
    autoTagsMtime: beforeNow(10),
    dismissedAutoTagsMtime: beforeNow(8),
    notes: index % 9 === 0 ? 'Revisit the architecture notes and examples.' : '',
    favorite: index % 8 === 0,
    mtime: beforeNow(8),
    gh_list_id: null,
  };
});

const WATCH_REPOSITORIES = [
  'aurora-workshop/atlas-notes',
  'meadow-labs/beacon-kit',
  'northwind-studio/circuit-garden',
  'paper-kite-dev/drift-console',
] as const;

const WATCH_REASONS = ['mention', 'review_requested', 'subscribed', 'assign'] as const;
const WATCH_TITLES = [
  'Clarify the keyboard navigation examples',
  'Add a compact layout option',
  'Document the cache invalidation rule',
  'Polish empty-state language',
  'Cover the parser edge case',
  'Review the color token naming',
  'Simplify the command output',
  'Explain the migration path',
  'Keep focus inside the details panel',
  'Refresh the contributor guide',
  'Add a deterministic ordering example',
  'Tune the small-screen spacing',
  'Preserve annotations during refresh',
  'Improve the project grouping labels',
  'Describe the offline behavior',
] as const;

const WATCH_THREADS: GitHubNotificationThread[] = [
  ...WATCH_TITLES.map((title, index) => {
    const repositoryFullName = WATCH_REPOSITORIES[index % WATCH_REPOSITORIES.length];
    const threadId = String(1001 + index);
    const subjectType = index % 3 === 1 ? 'PullRequest' : 'Issue';
    return {
      id: threadId,
      repositoryFullName,
      repositoryHtmlUrl: '#',
      repositoryOwnerLogin: repositoryFullName.split('/')[0] ?? null,
      repositoryOwnerAvatarUrl: [avatarSunUrl, avatarSkyUrl, avatarPlumUrl, avatarAmberUrl][index % 4],
      reason: WATCH_REASONS[index % WATCH_REASONS.length],
      subjectType,
      subjectTitle: title,
      subjectApiUrl: null,
      subjectHtmlUrl: '#',
      unread: index % 4 !== 3,
      updatedAt: beforeNow(index < 5 ? 0 : index < 10 ? 1 : 3, index % 5),
      lastReadAt: index % 4 === 3 ? beforeNow(2, index) : null,
      fetchedAt: beforeNow(1),
    };
  }),
  {
    id: '1099',
    repositoryFullName: 'aurora-workshop/inbox-bridge',
    repositoryHtmlUrl: '#',
    repositoryOwnerLogin: 'aurora-workshop',
    repositoryOwnerAvatarUrl: avatarSunUrl,
    reason: 'subscribed',
    subjectType: 'Issue',
    subjectTitle: 'Active Inbox thread outside local Stars',
    subjectApiUrl: null,
    subjectHtmlUrl: '#',
    unread: true,
    updatedAt: beforeNow(0, 6),
    lastReadAt: null,
    fetchedAt: beforeNow(1),
  },
];

const WATCH_DETAILS: Record<string, WatchSubjectDetail> = Object.fromEntries(
  WATCH_THREADS.map((thread, index) => {
    const number = 21 + index;
    const kind = thread.subjectType === 'PullRequest' ? 'pull_request' : 'issue';
    const authorLogin = ['lina-builds', 'omar-reads', 'ren-tools', 'sora-designs'][index % 4];
    return [thread.id, {
      kind,
      repositoryFullName: thread.repositoryFullName,
      number,
      title: thread.subjectTitle,
      state: index % 7 === 6 ? 'closed' : 'open',
      stateReason: index % 7 === 6 ? 'completed' : null,
      htmlUrl: '#',
      author: {
        login: authorLogin,
        avatarUrl: [avatarSkyUrl, avatarPlumUrl, avatarAmberUrl, avatarSunUrl][index % 4],
        htmlUrl: '#',
      },
      createdAt: beforeNow(16 + index),
      updatedAt: thread.updatedAt,
      labels: index % 2 === 0
        ? [{ name: 'demo-ready', color: '2f81f7' }]
        : [{ name: 'discussion', color: '8b5cf6' }],
      assignees: [],
      milestoneTitle: index % 5 === 0 ? 'Polish pass' : null,
      commentCount: 2 + index,
      bodyMarkdown: 'This synthetic thread demonstrates local Watch details without loading remote content.',
    } satisfies WatchSubjectDetail];
  }),
);

const WATCH_STATE: GitHubWatchStateRecord = {
  id: 'singleton',
  accountLogin: ACCOUNT_LOGIN,
  scope: {
    lastAttemptAt: beforeNow(1),
    lastSuccessfulAt: beforeNow(1),
    errorCode: null,
    repositoryCount: WATCH_REPOSITORIES.length,
  },
  inbox: {
    lastAttemptAt: beforeNow(0),
    lastSuccessfulAt: beforeNow(0),
    errorCode: null,
    lastModified: new Date(FIXED_NOW).toUTCString(),
    nextAllowedAt: null,
    candidateCount: WATCH_THREADS.length,
    matchedCount: WATCH_THREADS.length,
    scanId: null,
    scanStatus: 'complete',
    scanStartedAt: null,
    scanPageCount: 1,
    lastConvergedAt: beforeNow(0),
    truncated: false,
    newerThan: beforeNow(1),
    historyBefore: beforeNow(0),
    historyNextPage: null,
    historyExhausted: true,
    historyErrorCode: null,
  },
};

const RADAR_REPOSITORIES = [
  'aurora-workshop/atlas-notes',
  'glass-forest/tempo-grid',
  'meadow-labs/beacon-kit',
  'cobalt-grove/query-lens',
  'northwind-studio/circuit-garden',
  'soft-signal/pattern-book',
  'paper-kite-dev/drift-console',
  'winter-garden/trace-map',
] as const;
const RADAR_ACTORS = ['lina-builds', 'omar-reads', 'ren-tools', 'sora-designs'] as const;

const RADAR_ACTIVITIES: RadarActivityRecord[] = Array.from({ length: 12 }, (_, index) => {
  const repositoryFullName = RADAR_REPOSITORIES[index % RADAR_REPOSITORIES.length];
  const repositoryKey = repositoryFullName.toLocaleLowerCase('en-US');
  const actorLogin = RADAR_ACTORS[index % RADAR_ACTORS.length];
  const matchingStar = STARS.find((star) => star.full_name === repositoryFullName && !star.tombstone);
  return {
    id: `demo-radar-${String(index + 1).padStart(2, '0')}`,
    accountLogin: ACCOUNT_LOGIN,
    actorLogin,
    actorAvatarUrl: [avatarSkyUrl, avatarPlumUrl, avatarAmberUrl, avatarSunUrl][index % 4],
    repositoryKey,
    repositoryFullName,
    repositoryDisplayName: repositoryFullName,
    repositoryHtmlUrl: '#',
    repositoryDescription: `A fictional repository shared by ${actorLogin} in this local activity feed.`,
    repositoryLanguage: LANGUAGES[index % (LANGUAGES.length - 1)],
    repositoryLanguageColor: ['#3178c6', '#dea584', '#3572a5', '#00add8'][index % 4],
    repositoryOwnerLogin: repositoryFullName.split('/')[0] ?? null,
    repositoryOwnerAvatarUrl: [avatarSunUrl, avatarSkyUrl, avatarPlumUrl, avatarAmberUrl][index % 4],
    repositoryTopics: [...TOPICS[(index + 2) % TOPICS.length]],
    repositoryStargazerCount: 760 + index * 137,
    viewerHadStarred: matchingStar !== undefined,
    starredAt: beforeNow(1 + index),
    dismissedAt: null,
    seenAt: index % 4 === 3 ? beforeNow(1) : null,
  };
});

const RADAR_STATE: RadarStateRecord = {
  id: 'singleton',
  accountLogin: ACCOUNT_LOGIN,
  lastAttemptAt: beforeNow(1),
  lastSuccessfulAt: beforeNow(1),
  windowDays: 60,
  errorCode: null,
  nextAllowedAt: null,
  activityCount: RADAR_ACTIVITIES.length,
  followingCount: RADAR_ACTORS.length,
  scannedFollowingCount: RADAR_ACTORS.length,
  batchCount: 1,
  partialReasons: [],
  rateLimitRemaining: null,
  rateLimitResetAt: null,
};

const RECOMMENDATION_BATCH_NAMES = [
  ['blue-oak/outline-canvas', 'cloud-harbor/metric-garden', 'daylight-code/route-sketch', 'fern-labs/cache-lantern', 'golden-field/schema-compass', 'hollow-tree/terminal-cards', 'indigo-workshop/query-studio', 'juniper-dev/accessibility-map'],
  ['kindred-tools/logbook-ui', 'little-comet/prompt-atlas', 'maple-circuit/data-notebook', 'new-moon/command-deck', 'open-meadow/trace-reader', 'pebble-labs/layout-grid', 'redwood-code/event-catalog', 'soft-bridge/search-cards'],
  ['tall-pine/state-journal', 'umber-studio/component-field', 'violet-river/release-map', 'warm-signal/filter-lab', 'yellow-kite/topic-browser', 'zenith-grove/review-board', 'bright-path/notes-index', 'calm-orbit/project-shelf'],
] as const;

function recommendationRecord(fullName: string, batchIndex: number, index: number): RecommendationRecord {
  const [owner = '', name = ''] = fullName.split('/');
  const repositoryKey = fullName.toLocaleLowerCase('en-US');
  const signal = TOPICS[(batchIndex * 2 + index) % TOPICS.length][0];
  return {
    id: `demo-recommendation-${batchIndex + 1}-${index + 1}`,
    accountLogin: ACCOUNT_LOGIN,
    repositoryKey,
    repositoryFullName: fullName,
    repositoryHtmlUrl: '#',
    description: `A fictional ${signal} project selected for this deterministic recommendation batch.`,
    language: LANGUAGES[(batchIndex + index) % (LANGUAGES.length - 1)],
    stargazerCount: 920 + batchIndex * 400 + index * 173,
    topics: [signal, 'demo-project'],
    owner,
    name,
    pushedAt: beforeNow(2 + index),
    createdAt: beforeNow(300 + index * 11),
    fork: false,
    archived: false,
    score: 100 - index * 4 - batchIndex,
    reason: {
      kind: 'topic',
      value: signal,
      seedRepositoryKey: 'aurora-workshop/atlas-notes',
      seedRepositoryFullName: 'aurora-workshop/atlas-notes',
    },
    fetchedAt: beforeNow(1),
  };
}

const RECOMMENDATION_BATCHES: RecommendationRecord[][] = RECOMMENDATION_BATCH_NAMES.map(
  (batch, batchIndex) => batch.map((fullName, index) => recommendationRecord(fullName, batchIndex, index)),
);

const RECOMMENDATION_STATE: RecommendationStateRecord = {
  id: 'singleton',
  accountLogin: ACCOUNT_LOGIN,
  lastAttemptAt: beforeNow(1),
  lastSuccessfulAt: beforeNow(1),
  errorCode: null,
  nextAllowedAt: null,
  candidateCount: RECOMMENDATION_BATCHES[0].length,
  seedCount: 8,
  queryCount: 6,
  rateLimitRemaining: null,
  rateLimitResetAt: null,
};


const ACCOUNT: ManagerAccount = {
  username: ACCOUNT_LOGIN,
  displayName: 'Mina Vale (Demo)',
  avatarUrl: avatarSunUrl,
};

const PREFERENCES: ManagerPreferences = {
  theme: 'light',
  locale: 'en',
  radarWindowDays: 60,
  libraryView: {
    version: 1,
    filters: {
      languages: [],
      tags: [],
      tagMode: 'any',
      showTombstone: false,
      onlyFavorite: false,
      onlyUntagged: false,
      onlyArchived: false,
      onlyOwned: false,
    },
    sort: { sortKey: 'starred_at', sortDir: 'desc' },
  },
  watchCollapsedRepositories: {},
  columnLayoutMode: 'default',
  customColumnLayout: null,
};

const AVATAR_ASSETS: Record<string, string> = {
  default: avatarSunUrl,
  [ACCOUNT_LOGIN]: avatarSunUrl,
  'lina-builds': avatarSkyUrl,
  'omar-reads': avatarPlumUrl,
  'ren-tools': avatarAmberUrl,
  'sora-designs': avatarSunUrl,
  'aurora-workshop': avatarAmberUrl,
  'meadow-labs': avatarSkyUrl,
  'northwind-studio': avatarPlumUrl,
  'paper-kite-dev': avatarSunUrl,
  'quiet-river-code': avatarAmberUrl,
  'silver-maple': avatarSkyUrl,
  'tiny-orbit-tools': avatarPlumUrl,
};

export const DEMO_FIXTURE: DemoFixture = deepFreeze({
  now: FIXED_NOW,
  account: ACCOUNT,
  preferences: PREFERENCES,
  stars: STARS,
  tags: TAGS,
  tagMeta: TAG_META,
  watchThreads: WATCH_THREADS,
  watchState: WATCH_STATE,
  watchSubjectDetailsByThreadId: WATCH_DETAILS,
  radarActivities: RADAR_ACTIVITIES,
  radarState: RADAR_STATE,
  recommendationBatches: RECOMMENDATION_BATCHES,
  recommendationState: RECOMMENDATION_STATE,
  recommendationIgnores: [],
  avatarAssets: AVATAR_ASSETS,
} satisfies DemoFixture);
