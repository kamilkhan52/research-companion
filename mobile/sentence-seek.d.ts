export interface SentenceBoundary {
  text: string;
  startFrac: number;
  endFrac: number;
}

export const SENTENCE_SEEK_PREROLL_SECONDS: number;
export function sentenceSeekPosition(estimatedStart: number, prerollSeconds?: number): number;
export function splitSentences(text: string): SentenceBoundary[];
export function seekSentence(
  player: typeof import('react-native-track-player').default,
  direction: -1 | 1,
  fallbackSeconds?: number,
): Promise<'sentence' | 'track' | 'fallback'>;
