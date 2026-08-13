import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StarRow } from '@/ui/components/StarRow';
import type { Star } from '@/types';

function fakeStar(createdAt: string | null): Star {
  return {
    full_name: 'owner/repo',
    html_url: 'https://github.com/owner/repo',
    description: 'A repository',
    language: 'TypeScript',
    stargazers_count: 1200,
    topics: ['react'],
    archived: false,
    fork: false,
    created_at: createdAt,
    pushed_at: '2024-02-01T00:00:00Z',
    starred_at: '2024-03-01T00:00:00Z',
    tombstone: false,
    synced_at: '2024-03-02T00:00:00Z',
  };
}

function renderRepositoryAvatar(
  star: Star,
  showRepositoryAvatar: boolean,
  showRepositoryOwner = true,
): string {
  return renderToStaticMarkup(
    <StarRow
      star={star}
      showRepositoryOwner={showRepositoryOwner}
      showRepositoryAvatar={showRepositoryAvatar}
      tags={[]}
      hasNotes={false}
      favorite={false}
      favoriteBusy={false}
      selectedTags={[]}
      onToggleTag={vi.fn()}
      onToggleFavorite={vi.fn(async () => undefined)}
      selected={false}
      onSelect={vi.fn()}
      columns={['repository']}
      gridTemplateColumns="180px"
      flashedColumn={null}
    />,
  );
}

function renderCreatedColumn(createdAt: string | null): string {
  return renderToStaticMarkup(
    <StarRow
      star={fakeStar(createdAt)}
      tags={[]}
      hasNotes={false}
      favorite={false}
      favoriteBusy={false}
      selectedTags={[]}
      onToggleTag={vi.fn()}
      onToggleFavorite={vi.fn(async () => undefined)}
      selected={false}
      onSelect={vi.fn()}
      columns={['created']}
      gridTemplateColumns="84px"
      flashedColumn={null}
    />,
  );
}

function renderRepositoryColumn(searchQuery: string, showRepositoryOwner = true): string {
  return renderToStaticMarkup(
    <StarRow
      star={fakeStar('2020-01-02T12:00:00Z')}
      searchQuery={searchQuery}
      showRepositoryOwner={showRepositoryOwner}
      tags={[]}
      hasNotes={false}
      favorite={false}
      favoriteBusy={false}
      selectedTags={[]}
      onToggleTag={vi.fn()}
      onToggleFavorite={vi.fn(async () => undefined)}
      selected={false}
      onSelect={vi.fn()}
      columns={['repository']}
      gridTemplateColumns="180px"
      flashedColumn={null}
    />,
  );
}

describe('star row column rendering', () => {
  it('does not create an avatar image while the layout option is disabled', () => {
    const markup = renderRepositoryAvatar({
      ...fakeStar('2020-01-02T12:00:00Z'),
      owner_avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
    }, false);

    expect(markup).not.toContain('data-repository-avatar');
    expect(markup).not.toContain('<img');
  });

  it('layers a deterministic initial fallback below each lazy async avatar', () => {
    const markup = renderRepositoryAvatar({
      ...fakeStar('2020-01-02T12:00:00Z'),
      owner_avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
    }, true);

    expect(markup).toContain('data-repository-avatar-slot');
    expect(markup).toContain('data-repository-avatar-fallback');
    expect(markup).toContain('data-avatar-color=');
    expect(markup).toContain('>R</span>');
    expect(markup).toContain('data-repository-avatar');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('decoding="async"');
    expect(markup.indexOf('data-repository-avatar-fallback')).toBeLessThan(markup.indexOf('data-repository-avatar="true"'));
    expect(markup.indexOf('data-repository-avatar-slot')).toBeLessThan(markup.indexOf('owner/repo'));
  });

  it('renders the uppercase repository initial without an image when metadata is missing', () => {
    const markup = renderRepositoryAvatar(fakeStar('2020-01-02T12:00:00Z'), true, false);

    expect(markup).toContain('data-repository-avatar-slot');
    expect(markup).toContain('data-repository-avatar-fallback');
    expect(markup).toContain('>R</span>');
    expect(markup).not.toContain('<img');
  });

  it('maps repository identities to stable varied fallback colors', () => {
    const first = renderRepositoryAvatar(fakeStar('2020-01-02T12:00:00Z'), true);
    const repeated = renderRepositoryAvatar(fakeStar('2020-01-02T12:00:00Z'), true);
    const different = renderRepositoryAvatar({
      ...fakeStar('2020-01-02T12:00:00Z'),
      full_name: 'owner/another',
    }, true);
    const color = (markup: string) => markup.match(/data-avatar-color="([^"]+)"/)?.[1];

    expect(color(first)).toBeDefined();
    expect(color(repeated)).toBe(color(first));
    expect(color(different)).not.toBe(color(first));
  });

  it('applies the shared table min width when provided', () => {
    const markup = renderToStaticMarkup(
      <StarRow
        star={fakeStar('2020-01-02T12:00:00Z')}
        tags={[]}
        hasNotes={false}
        favorite={false}
        favoriteBusy={false}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onToggleFavorite={vi.fn(async () => undefined)}
        selected={false}
        onSelect={vi.fn()}
        columns={['created']}
        gridTemplateColumns="84px"
        minWidth={312}
        flashedColumn={null}
      />,
    );

    expect(markup).toContain('min-width:312px');
  });

  it('renders repository creation date when the created column is visible', () => {
    const markup = renderCreatedColumn('2020-01-02T12:00:00Z');

    expect(markup).toContain('data-row-col="created"');
    expect(markup).toContain('2020-01-02');
  });

  it('renders the empty placeholder when repository creation date is missing', () => {
    const markup = renderCreatedColumn(null);

    expect(markup).toContain('data-row-col="created"');
    expect(markup).toContain('—');
  });

  it('highlights a contiguous repository-name match with the semantic background token', () => {
    const markup = renderRepositoryColumn('REPO');

    expect(markup).toContain('data-search-match=""');
    expect(markup).toContain('bg-search-match/70');
    expect(markup).toContain('text-search-match-foreground');
    expect(markup).toContain('>repo</mark>');
    expect(markup).toContain('owner/');
  });

  it('highlights each original range for a fuzzy repository-name match', () => {
    const markup = renderRepositoryColumn('rpo');

    expect(markup.match(/data-search-match=""/g)).toHaveLength(2);
    expect(markup).toContain('>r</mark>');
    expect(markup).toContain('>po</mark>');
  });

  it('does not highlight the repository label when only metadata could match', () => {
    const markup = renderRepositoryColumn('repository description');

    expect(markup).not.toContain('data-search-match');
    expect(markup).toContain('owner/repo');
  });

  it('hides the owner without shifting repository-name highlights', () => {
    const markup = renderRepositoryColumn('repo', false);

    expect(markup).toContain('>repo</mark>');
    expect(markup).toContain('title="owner/repo"');
    expect(markup).toContain('aria-label="owner/repo"');
  });

  it('does not render an owner-only highlight when the owner is hidden', () => {
    const markup = renderRepositoryColumn('owner', false);

    expect(markup).not.toContain('data-search-match');
    expect(markup).toContain('aria-label="owner/repo">repo</span>');
  });
  it('renders a non-filtering personal fork row badge from repository metadata', () => {
    const markup = renderToStaticMarkup(
      <StarRow
        star={{ ...fakeStar('2020-01-02T12:00:00Z'), fork: true }}
        tags={['topic']}
        hasNotes={false}
        favorite={false}
        favoriteBusy={false}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onToggleFavorite={vi.fn(async () => undefined)}
        selected={false}
        onSelect={vi.fn()}
        columns={['repository', 'tags']}
        gridTemplateColumns="180px 140px"
        flashedColumn={null}
      />,
    );

    expect(markup).toContain('data-row-badge="fork"');
    expect(markup).toContain('Fork');
    expect(markup).toContain('data-inline-tag-measure="tag"');
    expect(markup).not.toMatch(/<button[^>]*>[\s\S]*Fork[\s\S]*<\/button>/);
  });

  it('uses the edit-layout star alignment in the default browse layout', () => {
    const markup = renderToStaticMarkup(
      <StarRow
        star={{ ...fakeStar('2020-01-02T12:00:00Z'), stargazers_count: 1234 }}
        tags={[]}
        hasNotes={false}
        favorite={false}
        favoriteBusy={false}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onToggleFavorite={vi.fn(async () => undefined)}
        selected={false}
        onSelect={vi.fn()}
        columns={['stars', 'updated']}
        gridTemplateColumns="64px 84px"
        minWidth={180}
        flashedColumn={null}
      />,
    );

    expect(markup).toContain('data-row-col="stars"');
    expect(markup).toContain('justify-start');
    expect(markup).not.toContain('justify-end');
  });

  it('keeps dense numeric and date columns clipped inside their tracks', () => {
    const markup = renderToStaticMarkup(
      <StarRow
        star={{ ...fakeStar('2020-01-02T12:00:00Z'), stargazers_count: 1234567 }}
        tags={[]}
        hasNotes={false}
        favorite={false}
        favoriteBusy={false}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onToggleFavorite={vi.fn(async () => undefined)}
        selected={false}
        onSelect={vi.fn()}
        columns={['stars', 'updated', 'created']}
        gridTemplateColumns="48px 72px 84px"
        minWidth={220}
        flashedColumn={null}
      />,
    );

    expect(markup).toContain('data-row-col="stars"');
    expect(markup).toContain('justify-start');
    expect(markup).toContain('overflow-hidden');
    expect(markup).toContain('min-w-0 truncate tabular-nums');
    expect(markup).toContain('data-row-col="updated"');
    expect(markup).toContain('min-w-0 truncate rounded-sm text-xs text-muted-foreground/70');
    expect(markup).toContain('data-row-col="created"');
  });

  it('keeps the same star alignment when a custom layout is rendered', () => {
    const markup = renderToStaticMarkup(
      <StarRow
        star={{ ...fakeStar('2020-01-02T12:00:00Z'), stargazers_count: 1234 }}
        tags={[]}
        hasNotes={false}
        favorite={false}
        favoriteBusy={false}
        selectedTags={[]}
        onToggleTag={vi.fn()}
        onToggleFavorite={vi.fn(async () => undefined)}
        selected={false}
        onSelect={vi.fn()}
        columns={['stars', 'updated']}
        gridTemplateColumns="64px 84px"
        minWidth={180}
        flashedColumn={null}
      />,
    );

    expect(markup).toContain('data-row-col="stars"');
    expect(markup).toContain('justify-start');
    expect(markup).not.toContain('justify-end');
  });

});

describe('owned public repository star state', () => {
  it('shows an honest disabled state instead of an Unstar action', () => {
    const markup = renderToStaticMarkup(
      <StarRow
        star={{ ...fakeStar('2024-01-01T00:00:00Z'), viewer_has_starred: false }}
        tags={[]}
        hasNotes={false}
        favorite={false}
        favoriteBusy={false}
        selectedTags={[]}
        onToggleTag={() => {}}
        onToggleFavorite={async () => {}}
        selected={false}
        onSelect={() => {}}
        columns={['starAction']}
        gridTemplateColumns="32px"
        flashedColumn={null}
        onConfirmUnstar={() => {}}
      />,
    );

    expect(markup).toContain('Owned public repository · not starred');
    expect(markup).not.toContain('Unstar owner/repo');
  });
});
