import { splitSentences } from '../../sentence-seek';
import { parseMessageAudioId, sessionAddressFromAudioSlug } from '@/audio/identity';

export interface DiscussionSentenceAnchor {
  id: string;
  text: string;
}

const words = (value: string): string[] => value
  .normalize('NFKD')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean);

function dice(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const counts = new Map<string, number>();
  for (const word of left) counts.set(word, (counts.get(word) ?? 0) + 1);
  let overlap = 0;
  for (const word of right) {
    const count = counts.get(word) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(word, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
}

function similarity(left: string, right: string): number {
  const a = words(left);
  const b = words(right);
  const token = dice(a, b);
  if (token === 1) return 1;
  const aPairs = a.slice(1).map((word, i) => `${a[i]}\u0000${word}`);
  const bPairs = b.slice(1).map((word, i) => `${b[i]}\u0000${word}`);
  return token * 0.8 + dice(aPairs, bPairs) * 0.2;
}

type Step = { pi: number; pj: number; ids: string[] | null };

/**
 * Deterministically align the spoken rewrite to immutable discussion anchors.
 *
 * Narration is instructed to preserve source order, but it may add a heading or split one long
 * source sentence in two. A monotonic dynamic program handles both without letting one extra
 * spoken line shift every later highlight. Weak matches are gaps: a missing highlight is safer
 * than confidently marking unrelated prose.
 */
export function alignNarrationToDiscussion(
  narration: string,
  anchors: DiscussionSentenceAnchor[],
): Array<string | null> {
  const spoken = splitSentences(narration).map((sentence) => sentence.text);
  const rows = spoken.length + 1;
  const cols = anchors.length + 1;
  const scores = Array.from({ length: rows }, () => Array(cols).fill(Number.NEGATIVE_INFINITY));
  const steps: Array<Array<Step | null>> = Array.from(
    { length: rows }, () => Array(cols).fill(null),
  );
  scores[0][0] = 0;
  const update = (i: number, j: number, score: number, step: Step) => {
    if (score > scores[i][j]) {
      scores[i][j] = score;
      steps[i][j] = step;
    }
  };

  for (let i = 0; i <= spoken.length; i += 1) {
    for (let j = 0; j <= anchors.length; j += 1) {
      const base = scores[i][j];
      if (!Number.isFinite(base)) continue;
      if (i < spoken.length) update(i + 1, j, base - 0.18, { pi: i, pj: j, ids: null });
      if (j < anchors.length) update(i, j + 1, base - 0.14, { pi: i, pj: j, ids: [] });
      if (i < spoken.length && j < anchors.length) {
        const match = similarity(spoken[i], anchors[j].text);
        if (match >= 0.5) {
          update(i + 1, j + 1, base + match - 0.34, {
            pi: i,
            pj: j,
            ids: [anchors[j].id],
          });
        }
      }
      if (i + 1 < spoken.length && j < anchors.length) {
        const first = similarity(spoken[i], anchors[j].text);
        const second = similarity(spoken[i + 1], anchors[j].text);
        const joined = similarity(`${spoken[i]} ${spoken[i + 1]}`, anchors[j].text);
        if (joined >= 0.58 && first >= 0.2 && second >= 0.2) {
          update(i + 2, j + 1, base + joined - 0.27, {
            pi: i,
            pj: j,
            ids: [anchors[j].id, anchors[j].id],
          });
        }
      }
    }
  }

  const result: Array<string | null> = Array(spoken.length).fill(null);
  let i = spoken.length;
  let j = anchors.length;
  while (i > 0 || j > 0) {
    const step = steps[i][j];
    if (!step) break;
    if (step.ids?.length) {
      const consumed = i - step.pi;
      for (let k = 0; k < consumed; k += 1) result[step.pi + k] = step.ids[k] ?? null;
    }
    i = step.pi;
    j = step.pj;
  }
  return result;
}

/** Only a content-qualified id may point at discussion text: an index-only legacy id can refer
 * to a retry branch whose words no longer match the audio. */
export function isContentQualifiedAudioId(id: string): boolean {
  return /#c[0-9a-z]+$/.test(id);
}

/** Resolve a narration to an assistant turn only when its complete tenant/conversation address
 * matches the Discussion on screen. Content is checked separately against the selected branch's
 * canonical hash, after that entry is loaded. */
export function discussionAssistantIndexForAudio(
  id: string,
  project: string,
  slug: string,
  threadId: string,
): number | null {
  if (!isContentQualifiedAudioId(id)) return null;
  const identity = parseMessageAudioId(id);
  if (!identity?.contentTag || identity.project !== project) return null;
  const address = sessionAddressFromAudioSlug(identity.slug);
  if (address.slug !== slug || address.threadId !== threadId) return null;
  return identity.assistantIndex;
}

/** An explicit mini-player jump is resolved after the seek and wins over the passive hook's
 * previous poll, but only for the same narration slot. */
export function discussionNarrationIndex(
  slotId: string,
  passiveIndex: number,
  jump: { slotId: string; activeIndex: number } | null,
): number {
  return jump?.slotId === slotId ? jump.activeIndex : passiveIndex;
}

export type DiscussionJumpAction = 'wait' | 'consume' | 'land';

/** Decide the one-shot jump lifecycle without letting an old screen consume a request while
 * navigation is still mounting its destination. */
export function discussionJumpAction({
  enabled,
  focused,
  jump,
  cursorSlotId,
  conversationMatched,
  targetNonce,
}: {
  enabled: boolean;
  focused: boolean;
  jump: { nonce: number; slotId: string } | null;
  cursorSlotId: string | null;
  conversationMatched: boolean;
  targetNonce: number | null;
}): DiscussionJumpAction {
  if (!jump) return 'wait';
  if (!enabled) return 'consume';
  if (!focused || jump.slotId !== cursorSlotId || !conversationMatched) return 'wait';
  return targetNonce === jump.nonce ? 'land' : 'consume';
}
