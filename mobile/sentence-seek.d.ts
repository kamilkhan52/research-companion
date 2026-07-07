export interface SentenceBoundary {
  text: string;
  startFrac: number;
  endFrac: number;
}

export function splitSentences(text: string): SentenceBoundary[];
export function seekSentence(
  player: typeof import('react-native-track-player').default,
  direction: -1 | 1,
  fallbackSeconds?: number,
): Promise<'sentence' | 'track' | 'fallback'>;
