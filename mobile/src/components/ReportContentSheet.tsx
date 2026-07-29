// Reporting offensive AI-generated content, without leaving the app.
//
// Google Play's AI-Generated Content policy requires that an app whose content is AI-generated
// "contain in-app user reporting or flagging features that allow users to report or flag offensive
// content to developers without needing to exit the app". Everything this app shows a reader is
// model output, so the requirement covers all of it — and "without needing to exit" is why this is
// a sheet over the content rather than a mailto: or a link to a web form.
//
// Built on OptionsSheet because that is the only menu idiom in the app (polish plan F.5). A reason
// is the whole report: the backend accepts a free-text note too, but asking someone who has just
// seen something objectionable to compose a paragraph is a good way to lose the report, and the
// pointer it stores is enough for an operator to find the exact turn.

import { useEffect, useState } from 'react';

import { reportContent } from '@/api/endpoints';
import type { ContentReportReason, ContentReportSurface } from '@/api/types';
import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';
import { useToast } from '@/ui/Toast';

/** The pointer a content report carries: which thread, and which turn within it.
 *
 *  Exported so its shape can be tested without rendering the chat surface. The THREAD is part of
 *  the identity — discussions are per-thread (`sessions/<slug>.threads/` server-side, a per-thread
 *  query key here), so `transcript:12` on `main` and on `t2` are different turns that would
 *  otherwise produce byte-identical reports, and an operator resolving one against the wrong
 *  thread finds an innocuous turn and dismisses a real report.
 *
 *  The index is the most volatile identifier available: a retry archives the old tail and puts a
 *  new response at the same index, and an edit rewinds and regenerates it. The backend deliberately
 *  stores no copy of the text, so nothing can detect that rot. Accepted for now — the alternative
 *  is storing content — and M7's review queue is where a sturdier handle belongs if it proves
 *  necessary. */
export function reportReference(threadId: string, transcriptIndex: number | null | undefined): string {
  return `thread:${threadId}/transcript:${transcriptIndex ?? -1}`;
}

const REASONS: { key: ContentReportReason; title: string; subtitle: string }[] = [
  { key: 'offensive', title: 'Offensive', subtitle: 'Rude, abusive, or degrading' },
  { key: 'harmful', title: 'Harmful or dangerous', subtitle: 'Unsafe advice or instructions' },
  { key: 'misinformation', title: 'Seriously misleading', subtitle: 'Stated as fact and wrong' },
  { key: 'sexual', title: 'Sexual content', subtitle: 'Explicit or suggestive' },
  { key: 'violent', title: 'Violent content', subtitle: 'Graphic or threatening' },
  { key: 'harassment', title: 'Harassment', subtitle: 'Targets a person or group' },
  { key: 'other', title: 'Something else', subtitle: 'Report it and describe it later' },
];

export function ReportContentSheet({
  visible,
  onClose,
  surface,
  projectId,
  paperSlug,
  reference,
}: {
  visible: boolean;
  onClose: () => void;
  surface: ContentReportSurface;
  projectId?: string | null;
  paperSlug?: string | null;
  /** Where in the transcript. A pointer for the operator — never the content itself. */
  reference?: string | null;
}) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);

  // Reset on open. `sending` is component state and this sheet is mounted for the life of the
  // screen, so without this it survived every open/close cycle and was shared across every message
  // a reader reported. With a request still in flight from one turn — `apiSend` sets no timeout, so
  // that can be tens of seconds on a bad connection — reporting a SECOND turn hit the guard below,
  // returned silently, and dismissed: no request, no toast, and a reader who believes they filed
  // something. Exactly the failure this file is written to avoid, introduced by the guard meant to
  // avoid it. The same idiom as `PaperSummaryRetrySheet`, which had it and this did not.
  useEffect(() => {
    if (visible) setSending(false);
  }, [visible]);

  async function send(reason: ContentReportReason) {
    // Now only a double-tap within one open sheet, which is the case it should cover.
    if (sending) return;
    setSending(true);
    // Closed immediately. The reader has made their choice and should not be held behind a
    // spinner on a network round trip; the toast reports either outcome.
    onClose();
    try {
      await reportContent({
        surface,
        reason,
        project_id: projectId ?? null,
        paper_slug: paperSlug ?? null,
        reference: reference ?? null,
      });
      toast('Reported. Thank you — we review these.');
    } catch (caught) {
      // Said plainly rather than swallowed: a report the reader believes was filed, and was not,
      // is worse than one that visibly failed. The server's message is written to be shown.
      toast(caught instanceof Error ? caught.message : 'Could not send that report.');
    } finally {
      setSending(false);
    }
  }

  const options: SheetOption[] = REASONS.map((reason) => ({
    key: reason.key,
    title: reason.title,
    subtitle: reason.subtitle,
    icon: 'flag',
    disabled: sending,
    onPress: () => void send(reason.key),
  }));

  return (
    <OptionsSheet
      visible={visible}
      onClose={onClose}
      title="Report this response"
      subtitle="Tell us what is wrong with it. Reports go to the people who run this server."
      options={options}
    />
  );
}
