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
    forks_count: 10,
    open_issues_count: 2,
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

describe('star row column rendering', () => {
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
});
