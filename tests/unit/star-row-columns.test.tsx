import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StarRow } from '@/ui/components/StarRow';
import type { Star } from '@/types';

function fakeStar(createdAt: string | null, pushedAt: string | null = '2024-02-01T00:00:00Z'): Star {
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
    pushed_at: pushedAt,
    starred_at: '2024-03-01T00:00:00Z',
    tombstone: false,
    synced_at: '2024-03-02T00:00:00Z',
  };
}

type RowProps = Partial<ComponentProps<typeof StarRow>>;

function renderRow(props: RowProps): string {
  return renderToStaticMarkup(
    <StarRow
      star={fakeStar('2020-01-02T12:00:00Z')}
      tags={[]}
      hasNotes={false}
      favorite={false}
      favoriteBusy={false}
      watched={false}
      watchReasonCount={0}
      selectedTags={[]}
      onToggleTag={vi.fn()}
      onToggleFavorite={vi.fn(async () => undefined)}
      selected={false}
      onSelect={vi.fn()}
      columns={['created']}
      gridTemplateColumns="84px"
      flashedColumn={null}
      {...props}
    />,
  );
}

function renderCreatedColumn(createdAt: string | null): string {
  return renderRow({ star: fakeStar(createdAt), columns: ['created'], gridTemplateColumns: '84px' });
}

function renderUpdatedColumn(pushedAt: string | null): string {
  return renderRow({ star: fakeStar('2020-01-02T12:00:00Z', pushedAt), columns: ['updated'], gridTemplateColumns: '84px' });
}

function renderTagsColumn(tags: string[]): string {
  return renderRow({ tags, columns: ['tags'], gridTemplateColumns: '220px' });
}

function renderRepositoryColumn({ watched, watchReasonCount }: { watched: boolean; watchReasonCount: number }): string {
  return renderRow({ watched, watchReasonCount, columns: ['repository'], gridTemplateColumns: '220px' });
}

describe('star row column rendering', () => {
  it('applies the shared table min width when provided', () => {
    const markup = renderRow({ minWidth: 312 });

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

  it('renders the empty placeholder when repository push date is missing', () => {
    const markup = renderUpdatedColumn(null);

    expect(markup).toContain('data-row-col="updated"');
    expect(markup).toContain('—');
  });

  it('keeps inline tag measurement non-interactive and hidden from accessibility', () => {
    const markup = renderTagsColumn(['ui', 'react', 'agent', 'tooling']);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup.match(/data-inline-tag-measure="tag"/g)).toHaveLength(4);
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain('+2');
  });

  it('renders the compact watch mark inside the repository cell', () => {
    const markup = renderRepositoryColumn({ watched: true, watchReasonCount: 2 });

    expect(markup).toContain('aria-label="Watched"');
    expect(markup).toContain('2');
  });

  it('keeps star values right-aligned in the default browse layout', () => {
    const markup = renderRow({
      star: { ...fakeStar('2020-01-02T12:00:00Z'), stargazers_count: 1234 },
      columns: ['stars', 'updated'],
      gridTemplateColumns: '64px 84px',
      minWidth: 180,
    });

    expect(markup).toContain('data-row-col="stars"');
    expect(markup).toContain('justify-end');
    expect(markup).not.toContain('justify-start');
  });

  it('keeps dense numeric and date columns clipped inside their tracks', () => {
    const markup = renderRow({
      star: { ...fakeStar('2020-01-02T12:00:00Z'), stargazers_count: 1234567 },
      columns: ['stars', 'updated', 'created'],
      gridTemplateColumns: '48px 72px 84px',
      minWidth: 220,
    });

    expect(markup).toContain('data-row-col="stars"');
    expect(markup).toContain('justify-end');
    expect(markup).toContain('overflow-hidden');
    expect(markup).toContain('min-w-0 truncate tabular-nums');
    expect(markup).toContain('data-row-col="updated"');
    expect(markup).toContain('min-w-0 truncate rounded-sm text-xs text-muted-foreground/70');
    expect(markup).toContain('data-row-col="created"');
  });

  it('keeps star values with their custom layout column group after editing is saved or previewed', () => {
    const markup = renderRow({
      star: { ...fakeStar('2020-01-02T12:00:00Z'), stargazers_count: 1234 },
      columns: ['stars', 'updated'],
      gridTemplateColumns: '64px 84px',
      minWidth: 180,
      starColumnAlignStart: true,
    });

    expect(markup).toContain('data-row-col="stars"');
    expect(markup).toContain('justify-start');
    expect(markup).not.toContain('justify-end');
  });
});
