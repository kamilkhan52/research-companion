// Optional haptics: the JS ships before the dev client containing the native module exists
// (expo-haptics is part of the phase-E rebuild batch), so the import is a guarded require —
// on the current build every call is a silent no-op, and the same bundle gains feedback the
// moment the rebuilt client is installed. Never import 'expo-haptics' directly elsewhere.

type HapticsModule = typeof import('expo-haptics');

let haptics: HapticsModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  haptics = require('expo-haptics') as HapticsModule;
} catch {
  haptics = null;
}

/** Light tick for selection-style interactions (tab switches, pickers). */
export function selectionTap(): void {
  void haptics?.selectionAsync().catch(() => undefined);
}

/** Soft impact for primary actions (mint buttons, send). */
export function impactTap(): void {
  if (!haptics) return;
  void haptics.impactAsync(haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}
