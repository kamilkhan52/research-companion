// R10.18 — app-wide duplicate awareness. Every add surface preflights through useAddPaper;
// when the scholarly identity already exists elsewhere, this single host explains the saved
// work and reuses project_split's proven Copy/Move path instead of creating a blank duplicate.

import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import * as api from '@/api/endpoints';
import { queryClient } from '@/api/queryClient';
import type { Paper, PaperLocation } from '@/api/types';
import { BottomSheet } from '@/components/BottomSheet';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { radius, space, type ThemePalette } from '@/theme/tokens';
import { Button, Icon, Text } from '@/ui';
import { showToast } from '@/ui/Toast';

export type AddPaperOutcome =
  | { action: 'added' | 'copied' | 'moved'; paper: Paper }
  | { action: 'cancelled'; paper: null };

interface ReuseOffer {
  targetPid: string;
  targetName: string;
  candidateTitle: string;
  canUpdateNotes: boolean;
  matches: PaperLocation[];
}

interface PendingReuse extends ReuseOffer {
  resolve: (outcome: AddPaperOutcome) => void;
}

let dispatch: ((offer: PendingReuse) => void) | null = null;

/** Suspend the add mutation while the user explicitly chooses Cancel, Copy, or Move. */
export function requestExistingPaperReuse(offer: ReuseOffer): Promise<AddPaperOutcome> {
  return new Promise((resolve) => {
    if (!dispatch) {
      // The root host is expected to be mounted. Never silently add a duplicate if it is not.
      resolve({ action: 'cancelled', paper: null });
      return;
    }
    dispatch({ ...offer, resolve });
  });
}

function paperFromLocation(location: PaperLocation): Paper {
  const {
    project_id: _projectId,
    project_name: _projectName,
    identity: _identity,
    has_discussion: _hasDiscussion,
    ...paper
  } = location;
  return paper;
}

function workSummary(location: PaperLocation): string {
  const parts = [
    location.list_status === 'read' ? 'Read' : 'Unread',
    location.retrieved ? 'full text' : null,
    location.has_notes ? 'Notes' : null,
    location.has_discussion ? 'discussion history' : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function ExistingPaperOfferHost() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [offer, setOffer] = useState<PendingReuse | null>(null);
  const [selected, setSelected] = useState<PaperLocation | null>(null);
  // Copy is the safe default in duplicate-awareness; Move becomes explicit via this switch.
  const [removeFromSource, setRemoveFromSource] = useState(false);
  const [draftNotes, setDraftNotes] = useState(true);
  const [cleanupSource, setCleanupSource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const offerRef = useRef<PendingReuse | null>(null);
  offerRef.current = offer;

  useEffect(() => {
    dispatch = (next) => {
      // A second add cannot strand the first mutation behind an unreachable sheet.
      offerRef.current?.resolve({ action: 'cancelled', paper: null });
      setOffer(next);
      setSelected(next.matches.length === 1 ? next.matches[0] : null);
      setRemoveFromSource(false);
      setDraftNotes(true);
      setCleanupSource(false);
      setError(null);
      setMoving(false);
    };
    return () => {
      dispatch = null;
      offerRef.current?.resolve({ action: 'cancelled', paper: null });
    };
  }, []);

  function finish(outcome: AddPaperOutcome) {
    const pending = offerRef.current;
    if (!pending) return;
    setOffer(null);
    setSelected(null);
    setError(null);
    setMoving(false);
    pending.resolve(outcome);
  }

  async function reuse() {
    if (!offer || !selected || moving) return;
    setError(null);
    setMoving(true);
    try {
      const result = await api.moveProject(selected.project_id, {
        dest_pid: offer.targetPid,
        slugs: [selected.slug],
        remove_from_source: removeFromSource,
        draft_destination_notes:
          offer.canUpdateNotes && selected.has_notes && draftNotes,
        cleanup_source_notes:
          offer.canUpdateNotes
          && selected.has_notes
          && removeFromSource
          && cleanupSource,
      });
      // Keep cross-project surfaces live even though the add mutation itself did not call the
      // ordinary add endpoint. Shapes mirror api/queries.ts without importing it (which would
      // cycle useAddPaper -> this host -> useMoveProject).
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['recentSessions'] });
      void queryClient.invalidateQueries({
        queryKey: ['project', offer.targetPid, 'state'],
      });
      void queryClient.invalidateQueries({
        queryKey: ['project', offer.targetPid, 'graph'],
      });
      void queryClient.invalidateQueries({
        queryKey: ['project', offer.targetPid, 'graphAuthors'],
      });
      if (removeFromSource) {
        void queryClient.invalidateQueries({
          queryKey: ['project', selected.project_id, 'state'],
        });
        void queryClient.invalidateQueries({
          queryKey: ['project', selected.project_id, 'graph'],
        });
        void queryClient.invalidateQueries({
          queryKey: ['project', selected.project_id, 'graphAuthors'],
        });
      }
      const action = removeFromSource ? 'moved' : 'copied';
      showToast(
        `${removeFromSource ? 'Moved' : 'Copied'} “${selected.title}” to “${offer.targetName}”`,
      );
      finish({ action, paper: paperFromLocation(selected) });
      // R10.17's destination queue is paper-by-paper. Open it immediately so migrated Notes
      // are reviewed and committed at the migration point, not discovered later.
      if (result.notes_jobs?.destination) router.push('/notes/working');
    } catch (e) {
      setError((e as Error).message ?? 'Could not reuse the saved paper.');
    } finally {
      setMoving(false);
    }
  }

  const notesEligible = !!selected?.has_notes;
  const canProposeNotes = notesEligible && !!offer?.canUpdateNotes;

  return (
    <BottomSheet
      visible={!!offer}
      onClose={() => finish({ action: 'cancelled', paper: null })}
      maxHeightPct={88}
      scrollable
    >
      {!selected ? (
        <>
          <Text variant="overline" color={t.violet}>ALREADY IN YOUR LIBRARY</Text>
          <Text variant="title" style={{ marginTop: space.xs }}>
            Choose the saved paper to reuse
          </Text>
          <Text variant="caption" color={t.muted} style={styles.intro}>
            “{offer?.candidateTitle}” is already in another project. Reuse its full text and
            reading work instead of starting a duplicate.
          </Text>
          <View style={styles.locationList}>
            {offer?.matches.map((location) => (
              <Pressable
                key={`${location.project_id}:${location.slug}`}
                onPress={() => setSelected(location)}
                accessibilityRole="button"
                accessibilityLabel={`Reuse ${location.title} from ${location.project_name}`}
                style={({ pressed }) => [
                  styles.location,
                  pressed && { backgroundColor: t.elevated },
                ]}
              >
                <View style={styles.locationIcon}>
                  <Icon name="folder" size={17} color={t.violet} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="heading" numberOfLines={1}>{location.project_name}</Text>
                  <Text variant="caption" color={t.muted} numberOfLines={1}>
                    {workSummary(location)}
                  </Text>
                </View>
                <Icon name="chevron-right" size={17} color={t.muted} />
              </Pressable>
            ))}
          </View>
          <Button
            title="Cancel"
            variant="ghost"
            onPress={() => finish({ action: 'cancelled', paper: null })}
            style={{ marginTop: space.lg }}
          />
        </>
      ) : (
        <>
          <Text variant="overline" color={t.violet}>SAVED IN “{selected.project_name}”</Text>
          <Text variant="serifTitle" style={{ marginTop: space.xs }}>
            {selected.title}
          </Text>
          <Text variant="caption" color={t.muted} style={styles.intro}>
            Copying preserves the source project. Moving removes the paper there only after
            its full text, Notes, discussion branches, and cached analysis reach
            “{offer?.targetName}”.
          </Text>

          <View style={styles.workCard}>
            {[
              [selected.retrieved, 'Full text'],
              [selected.has_notes, 'Committed Notes'],
              [selected.has_discussion, 'Discussion history and branches'],
            ].map(([available, label]) => (
              <View key={String(label)} style={styles.workRow}>
                <Icon
                  name={available ? 'check' : 'minus'}
                  size={15}
                  color={available ? t.mint : t.muted}
                />
                <Text variant="body" color={available ? t.text : t.muted}>
                  {String(label)}
                </Text>
              </View>
            ))}
          </View>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: space.md }}>
              <Text variant="body">Remove from “{selected.project_name}”</Text>
              <Text variant="caption" color={t.muted}>
                {removeFromSource
                  ? 'Move the paper and its saved work.'
                  : 'Keep an independent copy in both projects.'}
              </Text>
            </View>
            <Switch
              value={removeFromSource}
              onValueChange={setRemoveFromSource}
              trackColor={{ true: t.mint, false: t.line2 }}
              thumbColor={t.surface}
            />
          </View>

          {canProposeNotes ? (
            <>
              <View style={styles.toggleRow}>
                <View style={{ flex: 1, paddingRight: space.md }}>
                  <Text variant="body">Integrate into this project’s working notes</Text>
                  <Text variant="caption" color={t.muted}>
                    Opens a reviewable proposal for this paper immediately after reuse.
                  </Text>
                </View>
                <Switch
                  value={draftNotes}
                  onValueChange={setDraftNotes}
                  trackColor={{ true: t.mint, false: t.line2 }}
                  thumbColor={t.surface}
                />
              </View>
              {removeFromSource ? (
                <View style={styles.toggleRow}>
                  <View style={{ flex: 1, paddingRight: space.md }}>
                    <Text variant="body">Clean the source working notes</Text>
                    <Text variant="caption" color={t.muted}>
                      Proposes removing contributions tied to the departing paper.
                    </Text>
                  </View>
                  <Switch
                    value={cleanupSource}
                    onValueChange={setCleanupSource}
                    trackColor={{ true: t.mint, false: t.line2 }}
                    thumbColor={t.surface}
                  />
                </View>
              ) : null}
            </>
          ) : notesEligible ? (
            <Text variant="caption" color={t.muted} style={{ marginTop: space.md }}>
              The paper’s committed Notes still copy. Add an API key to also integrate them
              into this project’s working notes.
            </Text>
          ) : null}

          {error ? (
            <Text variant="caption" color={t.danger} style={{ marginTop: space.md }}>
              {error}
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Button
              title={offer && offer.matches.length > 1 ? 'Back' : 'Cancel'}
              variant="ghost"
              onPress={() => {
                if (offer && offer.matches.length > 1) {
                  setSelected(null);
                  setError(null);
                } else {
                  finish({ action: 'cancelled', paper: null });
                }
              }}
              style={{ flex: 1 }}
            />
            <Button
              title={removeFromSource ? 'Move here' : 'Copy here'}
              onPress={() => void reuse()}
              loading={moving}
              style={{ flex: 1 }}
            />
          </View>
        </>
      )}
    </BottomSheet>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  intro: { marginTop: space.sm, lineHeight: 19 },
  locationList: { gap: space.sm, marginTop: space.lg },
  location: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 1,
    borderColor: t.line2,
    borderRadius: radius.md,
    padding: space.md,
  },
  locationIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.elevated,
  },
  workCard: {
    gap: space.sm,
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: t.elevated,
    borderWidth: 1,
    borderColor: t.line,
  },
  workRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  toggleRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.lg },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xl },
});
