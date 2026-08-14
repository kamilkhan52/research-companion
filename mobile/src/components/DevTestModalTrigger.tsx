// DR-078 — the devtest trigger copy that native-Modal hosts (OptionsSheet, NotesReviewSheet)
// render inside their own OS window, because nothing in the base hierarchy can paint above a
// native Modal. The __DEV__ guard keeps DevTestBubble — and react-native-view-shot behind
// it — out of the release bundle entirely (same lazy-require pattern as DevTestOverlay in
// _layout.tsx). The RC_DEV runtime gate is NOT re-checked here: the inner component renders
// only while the root DevTestBubble is mounted, and _layout.tsx only mounts that when the
// server reports dev mode — re-deriving it here would drag react-query context requirements
// into every Modal host (and their tests) for a signal the root already owns.

export function DevTestModalTrigger() {
  if (!__DEV__) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DevTestFloatingTriggerIfActive } = require('@/components/DevTestBubble');
  return <DevTestFloatingTriggerIfActive />;
}
