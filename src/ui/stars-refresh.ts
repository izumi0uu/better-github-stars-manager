export type StarsQueryTrigger = 'initial-load' | 'filter-change' | 'data-change';

export function classifyStarsQueryTrigger(previousFilterKey: string | null, nextFilterKey: string): StarsQueryTrigger {
  if (previousFilterKey === null) return 'initial-load';
  return previousFilterKey === nextFilterKey ? 'data-change' : 'filter-change';
}
