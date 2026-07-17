// App-wide paper awareness (polish plan phase C): every mention of a project paper — an
// rc-paper link the analyst emitted, or an exact title match Markdown linkified — opens one
// small action sheet for that paper instead of hard-navigating, so the reader can hop between
// readings from anywhere (discussion, notes, related-works reasons).
//
// This provider is the single wiring point: it publishes the active project's paper index
// (PaperIndexContext, feeding Markdown's title linkification), installs the app-default link
// handler (rc-paper -> the sheet; http(s) -> the system browser), and renders the sheet.
// The discussion screen overrides the link handler with its own richer one (external-link
// alert with add-to-list) but routes its rc-paper taps back here via usePaperActions.

import { useRouter } from 'expo-router';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Linking } from 'react-native';

import { useProjectState } from '@/api/queries';
import type { Paper } from '@/api/types';
import { OptionsSheet, type SheetOption } from '@/components/chat/OptionsSheet';
import { LinkHandlerContext, PaperIndexContext, type LinkHandler } from '@/components/Markdown';
import { RelatedWorksSheet } from '@/components/RelatedWorksSheet';
import { useActiveProject } from '@/store/project';
import { fullPaperUrl } from '@/lib/paperLinks';
import { useTheme } from '@/theme/ThemeProvider';
import { stateMetaFor } from '@/theme/tokens';

const PaperActionsContext = createContext<((slug: string) => void) | null>(null);

/** Open the paper action sheet for a slug (no-op outside the provider). */
export function usePaperActions(): (slug: string) => void {
  return useContext(PaperActionsContext) ?? (() => {});
}

export function PaperEntityProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const t = useTheme();
  const { activePid } = useActiveProject();
  const stateQuery = useProjectState(activePid);
  const papers = stateQuery.data?.papers;
  const [slug, setSlug] = useState<string | null>(null);
  // Related works is its own bottom sheet layered after the action sheet closes.
  const [relatedSlug, setRelatedSlug] = useState<string | null>(null);

  const index = useMemo(
    () => (papers ?? []).map((p) => ({ title: p.title, slug: p.slug })),
    [papers],
  );

  const show = useCallback((s: string) => setSlug(s), []);

  // The app-default link handler: paper links open the sheet; anything else opens externally.
  const handleLink = useCallback<LinkHandler>(
    (href) => {
      if (href.startsWith('rc-paper:')) {
        const s = href.slice('rc-paper:'.length);
        if (s) setSlug(s);
        return;
      }
      if (/^https?:\/\//i.test(href)) void Linking.openURL(href).catch(() => undefined);
    },
    [],
  );

  const paper: Paper | undefined = slug ? papers?.find((p) => p.slug === slug) : undefined;
  const paperUrl = paper ? fullPaperUrl(paper) : null;
  const options = useMemo<SheetOption[]>(() => {
    if (!slug) return [];
    const close = () => setSlug(null);
    const opts: SheetOption[] = [
      {
        key: 'discussion',
        title: 'Open discussion',
        icon: 'message-circle',
        accent: t.mint,
        onPress: () => {
          close();
          router.push(`/paper/${encodeURIComponent(slug)}`);
        },
      },
    ];
    if (paper?.has_notes) {
      opts.push({
        key: 'notes',
        title: 'View notes',
        icon: 'file-text',
        accent: t.mint,
        onPress: () => {
          close();
          router.push(`/notes/${encodeURIComponent(slug)}`);
        },
      });
    }
    opts.push({
      key: 'related',
      title: 'Related works',
      icon: 'layers',
      onPress: () => {
        close();
        setRelatedSlug(slug);
      },
    });
    opts.push({
      key: 'map',
      title: 'Show in Map',
      icon: 'share-2',
      onPress: () => {
        close();
        // The nonce makes every "Show in Map" a fresh param set, so re-focusing the SAME
        // paper after the user closed its node sheet still re-selects (the Map's effect
        // keys on the params).
        router.navigate(`/graph?focus=${encodeURIComponent(slug)}&t=${Date.now()}`);
      },
    });
    if (paperUrl) {
      opts.push({
        key: 'source',
        title: 'Open full paper',
        subtitle: paperUrl.includes('arxiv.org/pdf/') ? 'PDF' : 'Source page',
        icon: 'external-link',
        onPress: () => {
          close();
          void Linking.openURL(paperUrl).catch(() => undefined);
        },
      });
    }
    return opts;
  }, [slug, paper?.has_notes, paperUrl, router, t]);

  const stateMeta = stateMetaFor(t);
  const stateKey = paper ? (paper.session_state ?? (paper.list_status === 'read' ? 'committed' : 'unread')) : null;
  const stateLabel = paper ? (stateMeta[stateKey ?? 'unread'] ?? stateMeta.unread).label : undefined;

  return (
    <PaperActionsContext.Provider value={show}>
      <PaperIndexContext.Provider value={index}>
        <LinkHandlerContext.Provider value={handleLink}>
          {children}
          <OptionsSheet
            visible={slug !== null}
            onClose={() => setSlug(null)}
            title={stateLabel}
            subtitle={paper?.title ?? slug ?? undefined}
            options={options}
          />
          <RelatedWorksSheet
            pid={activePid}
            slug={relatedSlug}
            visible={relatedSlug !== null}
            onClose={() => setRelatedSlug(null)}
            onOpenPaper={(target) => {
              setRelatedSlug(null);
              router.push(`/paper/${encodeURIComponent(target)}`);
            }}
          />
        </LinkHandlerContext.Provider>
      </PaperIndexContext.Provider>
    </PaperActionsContext.Provider>
  );
}
