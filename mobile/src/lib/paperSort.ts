// Library-list status buckets + sort (R9.12). Pure functions of Paper, kept out of the screen
// so they're unit-testable. Status filtering (which papers show) and sorting (their order) are
// deliberately separate concerns — the filter chips narrow, the sort reorders whatever remains.

import type { Paper } from '@/api/types';
import type { IconName } from '@/ui';

export type StatusFilter = 'all' | 'toread' | 'inprogress' | 'done';
export type StatusBucket = Exclude<StatusFilter, 'all'>;
export type SortKey = 'added' | 'name' | 'pubdate' | 'status';

export function paperStateKey(p: Paper): string {
  return p.session_state ?? (p.list_status === 'read' ? 'committed' : 'unread');
}

export function filterBucket(p: Paper): StatusBucket {
  const s = paperStateKey(p);
  if (s === 'committed' || s === 'read') return 'done';
  if (s === 'in_discussion' || s === 'notes_drafted') return 'inprogress';
  return 'toread';
}

export const SORTS: { key: SortKey; label: string; icon: IconName }[] = [
  { key: 'added', label: 'Date added', icon: 'clock' },
  { key: 'name', label: 'Name', icon: 'type' },
  { key: 'pubdate', label: 'Publication date', icon: 'calendar' },
  { key: 'status', label: 'Status', icon: 'activity' },
];

// Active work first, then unread, then done — surfaces what you're mid-way through.
const STATUS_RANK: Record<StatusBucket, number> = { inprogress: 0, toread: 1, done: 2 };

/** Reorder papers for display. 'added' preserves the server's reading-list order (oldest
 *  first) — the default, returned as-is so nothing changes until another sort is picked.
 *  Others sort a copy; Hermes's sort is stable, so ties keep reading-list order. */
export function sortPapers(papers: Paper[], sort: SortKey): Paper[] {
  if (sort === 'added') return papers;
  const copy = [...papers];
  switch (sort) {
    case 'name':
      return copy.sort((a, b) => a.title.localeCompare(b.title));
    case 'pubdate':
      // Newest first; papers with no known year sink to the bottom.
      return copy.sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity));
    case 'status':
      return copy.sort((a, b) => STATUS_RANK[filterBucket(a)] - STATUS_RANK[filterBucket(b)]);
  }
}
