// R7.8 — "analyze it while I keep browsing". After any paper is added, offer to kick off its
// first analysis in the background: the user picks a Reading Mode (or "Not now"), the server
// chains retrieval → session start → first turn (→ audio in listening mode) as durable jobs,
// and a quiet watcher here polls the chain to fire completion/error toasts. The offer arrives
// through a module-level emitter (the Toast pattern) so every add site — Discover, graph
// recommendations, related-works/external-ref sheets — gets it without wiring.

import { useEffect, useState } from 'react';

import * as api from '@/api/endpoints';
import { READING_MODE_LABELS, type ReadingMode } from '@/api/types';
import { useListeningMode } from '@/store/listening';
import { showToast } from '@/ui/Toast';
import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';

export interface AnalysisOffer {
  pid: string;
  slug: string;
  title: string;
  arxivId?: string;
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

/** Fire-and-forget: start the chain, then poll retrieval → analysis, toasting the outcome.
 *  Everything durable happens server-side; this watcher only narrates it, so an app restart
 *  loses at most the toast, never the analysis. */
async function runChain(offer: AnalysisOffer, mode: ReadingMode, listening: boolean) {
  const name = shortTitle(offer.title);
  try {
    const started = await api.startRetrievalJob(offer.pid, offer.slug, {
      arxiv_id: offer.arxivId,
      auto_analyze: true,
      mode,
      delivery_mode: listening ? 'listening' : 'reading',
    });
    const deadline = Date.now() + WATCH_LIMIT_MS;
    let job = started.job;
    while (job.status === 'running' && Date.now() < deadline) {
      await sleep(RETRIEVAL_POLL_MS);
      job = (await api.getRetrievalJob(offer.pid, job.id)).job;
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
    let chat = (await api.getChatJob(offer.pid, job.analysis_job_id)).job;
    while (chat.status === 'running' && Date.now() < deadline) {
      await sleep(ANALYSIS_POLL_MS);
      chat = (await api.getChatJob(offer.pid, job.analysis_job_id)).job;
    }
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
      if (offer) {
        void runChain(offer, mode, listeningMode);
        showToast('Analysis started — you can keep browsing');
      }
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
