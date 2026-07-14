import type { GraphStatus } from '@/api/types';

export function canStartGraphBuild(
  status: Pick<GraphStatus, 'total_papers'> | null,
): boolean {
  return Boolean(status && status.total_papers > 0);
}
