import { useEffect, useRef } from 'react';

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
  parentJobRef,
}: {
  enabled: boolean;
  project: string | null;
  title: string;
  jobIds: string[];
  playPreview: (id: string, title: string, url: string) => Promise<boolean>;
  parentJobRef: { readonly current: string | null };
}) {
  const aliveRef = useRef(true);
  const enabledRef = useRef(enabled);
  const projectRef = useRef(project);
  const inFlightRef = useRef(new Set<string>());
  enabledRef.current = enabled;
  projectRef.current = project;

  useEffect(() => () => {
    aliveRef.current = false;
  }, []);

  useEffect(() => {
    const parentJobId = parentJobRef.current;
    if (!enabled || !parentJobId) {
      for (const jobId of jobIds) handledPreviewJobs.add(jobId);
      return;
    }
    if (!project) return;
    for (const jobId of jobIds) {
      if (handledPreviewJobs.has(jobId) || inFlightRef.current.has(jobId)) continue;
      inFlightRef.current.add(jobId);
      void (async () => {
        let failures = 0;
        try {
          while (aliveRef.current && enabledRef.current && parentJobRef.current === parentJobId
                 && projectRef.current === project) {
            try {
              const { job } = await api.getPreviewJob(project, jobId);
              failures = 0;
              if (job.status === 'running') {
                await sleep(POLL_MS);
                continue;
              }
              handledPreviewJobs.add(jobId);
              if (enabledRef.current && parentJobRef.current === parentJobId
                  && projectRef.current === project
                  && job.status === 'done' && !job.suppressed && job.url) {
                await playPreview(`preview:${job.id}`, `Preview · ${title}`, job.url);
              }
              return;
            } catch {
              if (++failures >= MAX_POLL_FAILURES) return;
              await sleep(POLL_MS);
            }
          }
        } finally {
          inFlightRef.current.delete(jobId);
        }
      })();
    }
  }, [enabled, jobIds, parentJobRef, playPreview, project, title]);
}
