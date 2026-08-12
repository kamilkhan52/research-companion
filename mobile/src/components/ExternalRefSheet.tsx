// Action sheet for an EXTERNAL reference link tapped in a discussion (U.7): a paper the agent
// found on the web, not (necessarily) in the project. Replaces the old bare Alert with the
// same sheet language the rest of the app uses, and is live-membership aware — a paper that is
// already in the project (or was just added) shows that state instead of offering Add again.

import { useState } from 'react';
import { Alert, Linking } from 'react-native';

import { useAddPaper, useProjectMembership } from '@/api/queries';
import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';
import { scholarSearchUrl, titleFromRcSearchLink } from '@/lib/paperLinks';
import { useTheme } from '@/theme/ThemeProvider';

export interface ExternalRef {
  href: string;
  label?: string;
}

/** The arXiv id inside an abs/pdf URL, or null for non-arXiv links. */
export function parseArxivId(href: string): string | null {
  const match = href.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
  return match ? match[1] : null;
}

export function ExternalRefSheet({
  pid,
  refItem,
  onClose,
}: {
  pid: string | null;
  refItem: ExternalRef | null;
  onClose: () => void;
}) {
  const t = useTheme();
  const addPaper = useAddPaper(pid ?? '');
  const { isInProject } = useProjectMembership(pid);
  // Keyed by href so the "Added" state belongs to the link that was added, not whichever
  // reference the sheet shows next.
  const [addedHref, setAddedHref] = useState<string | null>(null);

  if (!refItem) return null;
  const arxivId = parseArxivId(refItem.href);
  // DR-054: the model has no real URL for this one — it's a name-only citation
  // (`rc-search:<title>`), the app-internal scheme it uses instead of fabricating a source.
  const isRealUrl = /^https?:\/\//i.test(refItem.href);
  // A label that is a URL (models often write "available at [arxiv.org/…](url)") is not a
  // title; without a title, membership can only match by arXiv id, and an add falls back to
  // an "arXiv <id>" placeholder (the discussion opens with the real paper title later).
  const urlish = /^(https?:\/\/|www\.|arxiv\.org\b|doi\.org\b)/i;
  const rawLabel = refItem.label?.trim();
  const title = rawLabel && rawLabel !== refItem.href && !urlish.test(rawLabel) ? rawLabel : null;
  // DR-054, Opus review: `title` is null whenever the label is missing, URL-shaped, or equals
  // the href — every one of the existing `title ?? refItem.href` fallbacks below would then
  // store or display the raw `rc-search:<title>` marker verbatim (a reading-list entry
  // literally titled "rc-search:LoongServe", committed to git). Decode the marker itself as
  // the next-best title before ever falling all the way to the bare href.
  const bestTitle = title ?? titleFromRcSearchLink(refItem.href);
  const added = addedHref === refItem.href;
  const inProject = added || isInProject({ arxivId, title: bestTitle });

  async function handleAdd() {
    if (!pid || inProject || addPaper.isPending) return;
    try {
      const result = await addPaper.mutateAsync({
        // Never store a URL (real or the rc-search: marker) as a reading-list title; the
        // arXiv placeholder mirrors the Discover paste flow (retrieval fills in the real title).
        title: bestTitle ?? (arxivId ? `arXiv ${arxivId}` : refItem!.href),
        arxivId: arxivId ?? undefined,
        // Without an arXiv id the href is the only source we have — carry it so the
        // analysis offer's retrieval fetches that link instead of title-searching. A
        // name-only citation has no source URL at all, real or otherwise.
        pdfUrl: !isRealUrl || arxivId ? undefined : refItem!.href,
      });
      if (!result.paper) return;
      setAddedHref(refItem!.href);
    } catch (e) {
      Alert.alert('Could not add paper', (e as Error).message);
    }
  }

  const options: SheetOption[] = [
    isRealUrl
      ? {
          key: 'open',
          title: 'Open link',
          subtitle: refItem.href,
          icon: 'external-link',
          onPress: () => {
            onClose();
            void Linking.openURL(refItem.href).catch(() => undefined);
          },
        }
      : {
          key: 'open',
          title: 'Search Scholar',
          subtitle: bestTitle ?? undefined,
          icon: 'search',
          onPress: () => {
            onClose();
            void Linking.openURL(scholarSearchUrl(bestTitle ?? '')).catch(() => undefined);
          },
        },
    inProject
      ? {
          key: 'add',
          title: added ? 'Added to reading list' : 'Already in this project',
          icon: 'check',
          accent: t.mint,
          disabled: true,
          onPress: () => {},
        }
      : {
          key: 'add',
          title: addPaper.isPending ? 'Adding…' : 'Add to reading list',
          subtitle: arxivId ? `arXiv:${arxivId}` : undefined,
          icon: 'plus',
          accent: t.mint,
          disabled: !pid || addPaper.isPending,
          onPress: () => void handleAdd(),
        },
  ];

  return (
    <OptionsSheet
      visible
      onClose={onClose}
      title="External reference"
      subtitle={bestTitle ?? refItem.href}
      options={options}
    />
  );
}
