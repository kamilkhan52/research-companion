import { useEffect, useMemo, useRef, useState } from 'react';

import * as api from '@/api/endpoints';

const POLL_MS = 700;
const MAX_POLL_FAILURES = 6;
const handledPreviewJobs = new Set<string>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function usePreviewCues({
  enabled,
  project,
  title,
  jobIds,
  playPreview,
  parentJobId,
}: {
  enabled: boolean;
  project: string | null;
  title: string;
  jobIds: string[];
  playPreview: (id: string, title: string, url: string) => Promise<boolean>;
  parentJobId: string | null;
}) {
  const [continuedJobIds, setContinuedJobIds] = useState<string[]>([]);
  const inFlightRef = useRef(new Set<string>());

  useEffect(() => {
    setContinuedJobIds((current) => (current.length ? [] : current));
    if (!enabled || !project || !parentJobId) return;

    let cancelled = false;
    void (async () => {
      let failures = 0;
      while (!cancelled) {
        try {
          const { job } = await api.getChatJob(project, parentJobId);
          if (cancelled) return;
          failures = 0;
          setContinuedJobIds((current) => (
            current.length === job.preview_job_ids.length
              && current.every((id, index) => id === job.preview_job_ids[index])
              ? current
              : job.preview_job_ids
          ));
          if (job.preview_complete) return;
        } catch {
          if (cancelled || ++failures >= MAX_POLL_FAILURES) return;
        }
        await sleep(POLL_MS);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, parentJobId, project]);

  const allJobIds = useMemo(
    () => Array.from(new Set([...jobIds, ...continuedJobIds])),
    [continuedJobIds, jobIds],
  );
  const allJobIdsKey = allJobIds.join('\0');

  useEffect(() => {
    if (!enabled || !parentJobId) {
      for (const jobId of allJobIds) handledPreviewJobs.add(jobId);
      return;
    }
    if (!project) return;

    let cancelled = false;
    for (const jobId of allJobIds) {
      if (handledPreviewJobs.has(jobId) || inFlightRef.current.has(jobId)) continue;
      inFlightRef.current.add(jobId);
      void (async () => {
        let failures = 0;
        try {
          while (!cancelled) {
            try {
              const { job } = await api.getPreviewJob(project, jobId);
              if (cancelled) return;
              failures = 0;
              if (job.status === 'running') {
                await sleep(POLL_MS);
                continue;
              }
              handledPreviewJobs.add(jobId);
              if (job.status === 'done' && !job.suppressed && job.url) {
                await playPreview(`preview:${job.id}`, `Preview · ${title}`, job.url);
              }
              return;
            } catch {
              if (cancelled || ++failures >= MAX_POLL_FAILURES) return;
              await sleep(POLL_MS);
            }
          }
        } finally {
          inFlightRef.current.delete(jobId);
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  // The joined key keeps polling stable when a caller recreates an equivalent ids array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allJobIdsKey, enabled, parentJobId, playPreview, project, title]);
}
