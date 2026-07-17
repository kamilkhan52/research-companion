// R7.8 — "analyze it while I keep browsing". After any paper is added, offer to kick off its
// first analysis in the background: the user picks a Reading Mode (or "Not now"), the server
// chains retrieval → session start → first turn (→ audio in listening mode) as durable jobs,
// and a quiet watcher here polls the chain to fire completion/error toasts. The offer arrives
// through a module-level emitter (the Toast pattern) so every add site — Discover, graph
// recommendations, related-works/external-ref sheets — gets it without wiring.

import { useEffect, useState } from 'react';

import * as api from '@/api/endpoints';
import { queryClient } from '@/api/queryClient';
import { READING_MODE_LABELS, type ReadingMode, type RetrievalJob } from '@/api/types';
import { useListeningMode } from '@/store/listening';
import { showToast } from '@/ui/Toast';
import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';

export interface AnalysisOffer {
  pid: string;
  slug: string;
  title: string;
  arxivId?: string;
  /** Direct PDF link (URL adds) — retrieval must fetch exactly this source. */
  pdfUrl?: string;
}

// Imperative bridge: the mounted provider registers its dispatcher here so useAddPaper's
// onSuccess (plain mutation code) can raise the offer.
let dispatch: ((offer: AnalysisOffer) => void) | null = null;
export function offerInitialAnalysis(offer: AnalysisOffer) {
  dispatch?.(offer);
}

const MODES: ReadingMode[] = ['balanced', 'background', 'technical', 'detailed'];
const RETRIEVAL_POLL_MS = 4000;
const ANALYSIS_POLL_MS = 5000;
const WATCH_LIMIT_MS = 25 * 60 * 1000; // generous: agentic PDF hunts + long analyses

function shortTitle(title: string): string {
  return title.length > 48 ? `${title.slice(0, 45)}…` : title;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Refresh what the chain just changed server-side. Key shapes mirror `keys` in
 *  api/queries.ts (importing it here would cycle queries → this module → queries): an open
 *  ComposeFirst for this paper must flip to the live discussion, not sit on a stale empty
 *  transcript whose Start button would clobber the finished session. */
function refreshSession(pid: string, slug: string) {
  void queryClient.invalidateQueries({ queryKey: ['project', pid, 'session', slug] });
  void queryClient.invalidateQueries({ queryKey: ['project', pid, 'state'] });
  void queryClient.invalidateQueries({ queryKey: ['recentSessions'] });
}

/** Fire-and-forget: start the chain, then poll retrieval → analysis, toasting the outcome.
 *  Everything durable happens server-side; this watcher only narrates it, so an app restart
 *  loses at most the toast, never the analysis. */
async function runChain(offer: AnalysisOffer, mode: ReadingMode, listening: boolean) {
  const name = shortTitle(offer.title);
  const startOpts = {
    arxiv_id: offer.arxivId,
    pdf_url: offer.pdfUrl,
    auto_analyze: true,
    mode,
    delivery_mode: (listening ? 'listening' : 'reading') as 'listening' | 'reading',
  };
  // The start POST is the durable hand-off — only confirm once it actually succeeded. A
  // failure here means NO server-side job exists, which must not read like a polling hiccup.
  let startedJob: RetrievalJob;
  try {
    startedJob = (await api.startRetrievalJob(offer.pid, offer.slug, startOpts)).job;
  } catch (e) {
    showToast(`Couldn't start the analysis for “${name}” — ${(e as Error).message ?? 'server unreachable'}`);
    return;
  }
  showToast('Analysis started — you can keep browsing');
  try {
    const deadline = Date.now() + WATCH_LIMIT_MS;
    const settle = async (start: RetrievalJob): Promise<RetrievalJob> => {
      let job = start;
      while (job.status === 'running' && Date.now() < deadline) {
        await sleep(RETRIEVAL_POLL_MS);
        job = (await api.getRetrievalJob(offer.pid, job.id)).job;
      }
      return job;
    };
    let job = await settle(startedJob);
    if (
      job.status === 'done' && job.retrieved && !job.analysis_job_id && !job.analysis_error
    ) {
      // The chain was requested onto a retrieval another client had already started, and the
      // hook missed its completion — re-POST once: the paper is retrieved now, so this run
      // short-circuits and kicks the analysis inline.
      job = await settle((await api.startRetrievalJob(offer.pid, offer.slug, { ...startOpts, arxiv_id: undefined, pdf_url: undefined })).job);
    }
    if (job.phase === 'confirmation') {
      showToast(`“${name}” needs source confirmation — open it to choose`);
      return;
    }
    if (job.status !== 'done' || !job.retrieved) {
      showToast(`Couldn't fetch “${name}” — open it to retry`);
      return;
    }
    if (!job.analysis_job_id) {
      showToast(`“${name}” fetched, but the analysis didn't start${job.analysis_error ? ` — ${job.analysis_error}` : ''}`);
      return;
    }
    // The session now exists server-side (first turn generating) — flip any open
    // ComposeFirst for this paper to the live discussion.
    refreshSession(offer.pid, offer.slug);
    let chat = (await api.getChatJob(offer.pid, job.analysis_job_id)).job;
    while (chat.status === 'running' && Date.now() < deadline) {
      await sleep(ANALYSIS_POLL_MS);
      chat = (await api.getChatJob(offer.pid, job.analysis_job_id)).job;
    }
    refreshSession(offer.pid, offer.slug);
    if (chat.status === 'done') {
      showToast(`First analysis ready · ${name}`);
    } else if (chat.status === 'error') {
      showToast(`Analysis failed for “${name}” — open it to retry`);
    }
  } catch {
    // The server keeps working without the watcher; a dead poll just means no toast.
  }
}

export function InitialAnalysisOfferHost() {
  const { listeningMode } = useListeningMode();
  const [offer, setOffer] = useState<AnalysisOffer | null>(null);

  useEffect(() => {
    dispatch = setOffer;
    return () => {
      dispatch = null;
    };
  }, []);

  const options: SheetOption[] = MODES.map((mode) => ({
    key: mode,
    title: READING_MODE_LABELS[mode],
    icon: 'book-open' as const,
    onPress: () => {
      if (offer) void runChain(offer, mode, listeningMode);
      setOffer(null);
    },
  }));
  options.push({
    key: 'skip',
    title: 'Not now',
    subtitle: 'Just add it to the reading list',
    icon: 'x',
    section: true,
    onPress: () => setOffer(null),
  });

  return (
    <OptionsSheet
      visible={!!offer}
      onClose={() => setOffer(null)}
      title="Start the first analysis?"
      subtitle={offer?.title}
      options={options}
    />
  );
}
