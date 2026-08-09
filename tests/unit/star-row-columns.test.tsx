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
