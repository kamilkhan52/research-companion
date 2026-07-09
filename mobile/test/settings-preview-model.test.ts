import { previewModelDraft, previewModelPatch } from '@/settings/previewModel';

test('unset preview model remains dynamically unset when narration changes', () => {
  const initialDraft = previewModelDraft('');
  expect(initialDraft).toBe('');

  // A narration-model refetch must not materialize its effective value into this raw override.
  expect(previewModelDraft('')).toBe('');
  expect(previewModelPatch(initialDraft)).toBe('');
});

test('clearing an explicit preview override sends the empty-string removal sentinel', () => {
  expect(previewModelDraft('preview/model')).toBe('preview/model');
  expect(previewModelPatch('   ')).toBe('');
});
