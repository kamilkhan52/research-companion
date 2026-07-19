// Library-list status buckets + sort (R9.12). Pure functions of Paper, kept out of the screen
// so they're unit-testable. Status filtering (which papers show) and sorting (their order) are
// deliberately separate concerns — the filter chips narrow, the sort reorders whatever remains.

import type { Paper } from '@/api/types';
import type { IconName } from '@/ui';

export type StatusFilter = 'all' | 'toread' | 'inprogress' | 'done';
export type StatusBucket = Exclude<StatusFilter, 'all'>;
export type SortKey = 'added' | 'name' | 'pubdate' | 'status';
export type SortDirection = 'asc' | 'desc';

export interface SortDirectionOption {
  key: SortDirection;
  label: string;
  icon: IconName;
}

export interface PaperSortOption {
  key: SortKey;
  label: string;
  icon: IconName;
  directions?: SortDirectionOption[];
}

export function paperStateKey(p: Paper): string {
  return p.session_state ?? (p.list_status === 'read' ? 'committed' : 'unread');
}

export function filterBucket(p: Paper): StatusBucket {
  const s = paperStateKey(p);
  if (s === 'committed' || s === 'read') return 'done';
  if (s === 'in_discussion' || s === 'notes_drafted') return 'inprogress';
  return 'toread';
}

export const SORTS: PaperSortOption[] = [
  {
    key: 'added',
    label: 'Date added',
    icon: 'clock',
    directions: [
      { key: 'asc', label: 'Oldest added first', icon: 'arrow-up' },
      { key: 'desc', label: 'Newest added first', icon: 'arrow-down' },
    ],
  },
  {
    key: 'name',
    label: 'Name',
    icon: 'type',
    directions: [
      { key: 'asc', label: 'A to Z', icon: 'arrow-up' },
      { key: 'desc', label: 'Z to A', icon: 'arrow-down' },
    ],
  },
  {
    key: 'pubdate',
    label: 'Publication date',
    icon: 'calendar',
    directions: [
      { key: 'asc', label: 'Oldest published first', icon: 'arrow-up' },
      { key: 'desc', label: 'Newest published first', icon: 'arrow-down' },
    ],
  },
  { key: 'status', label: 'Status', icon: 'activity' },
];

// Active work first, then unread, then done — surfaces what you're mid-way through.
const STATUS_RANK: Record<StatusBucket, number> = { inprogress: 0, toread: 1, done: 2 };

/** Reorder papers for display. Ascending date-added preserves the server's reading-list
 *  order (oldest first) and is the default. Other variants sort a copy; Hermes's sort is
 *  stable, so ties keep reading-list order. Unknown publication years always stay last. */
export function sortPapers(
  papers: Paper[],
  sort: SortKey,
  direction: SortDirection = 'asc',
): Paper[] {
  if (sort === 'added') return direction === 'asc' ? papers : [...papers].reverse();
  const copy = [...papers];
  const sign = direction === 'asc' ? 1 : -1;
  switch (sort) {
    case 'name':
      return copy.sort((a, b) => sign * a.title.localeCompare(b.title));
    case 'pubdate':
      return copy.sort((a, b) => {
        if (a.year == null && b.year == null) return 0;
        if (a.year == null) return 1;
        if (b.year == null) return -1;
        return sign * (a.year - b.year);
      });
    case 'status':
      return copy.sort((a, b) => STATUS_RANK[filterBucket(a)] - STATUS_RANK[filterBucket(b)]);
  }
}
