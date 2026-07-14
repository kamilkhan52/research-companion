// Action sheet for an EXTERNAL reference link tapped in a discussion (U.7): a paper the agent
// found on the web, not (necessarily) in the project. Replaces the old bare Alert with the
// same sheet language the rest of the app uses, and is live-membership aware — a paper that is
// already in the project (or was just added) shows that state instead of offering Add again.

import { useState } from 'react';
import { Alert, Linking } from 'react-native';

import { useAddPaper, useProjectMembership } from '@/api/queries';
import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';
import { colors } from '@/theme/tokens';

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
  const addPaper = useAddPaper(pid ?? '');
  const { isInProject } = useProjectMembership(pid);
  // Keyed by href so the "Added" state belongs to the link that was added, not whichever
  // reference the sheet shows next.
  const [addedHref, setAddedHref] = useState<string | null>(null);

  if (!refItem) return null;
  const arxivId = parseArxivId(refItem.href);
  // A label that is just the URL again is not a title; without a title, membership can only
  // match by arXiv id.
  const title = refItem.label && refItem.label !== refItem.href ? refItem.label : null;
  const added = addedHref === refItem.href;
  const inProject = added || isInProject({ arxivId, title });

  async function handleAdd() {
    if (!pid || inProject || addPaper.isPending) return;
    try {
      await addPaper.mutateAsync({
        title: title ?? refItem!.href,
        arxivId: arxivId ?? undefined,
      });
      setAddedHref(refItem!.href);
    } catch (e) {
      Alert.alert('Could not add paper', (e as Error).message);
    }
  }

  const options: SheetOption[] = [
    {
      key: 'open',
      title: 'Open link',
      subtitle: refItem.href,
      icon: 'external-link',
      onPress: () => {
        onClose();
        void Linking.openURL(refItem.href).catch(() => undefined);
      },
    },
    inProject
      ? {
          key: 'add',
          title: added ? 'Added to reading list' : 'Already in this project',
          icon: 'check',
          accent: colors.mint,
          disabled: true,
          onPress: () => {},
        }
      : {
          key: 'add',
          title: addPaper.isPending ? 'Adding…' : 'Add to reading list',
          subtitle: arxivId ? `arXiv:${arxivId}` : undefined,
          icon: 'plus',
          accent: colors.mint,
          disabled: !pid || addPaper.isPending,
          onPress: () => void handleAdd(),
        },
  ];

  return (
    <OptionsSheet
      visible
      onClose={onClose}
      title="External reference"
      subtitle={title ?? refItem.href}
      options={options}
    />
  );
}
