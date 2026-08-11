// DR-060 — the device-test companion's tester-facing ordering: the verify queue first (it is
// why the feature exists), open work second, everything else collapsed.

import { sectionItems } from '@/components/DevTestBubble';

const item = (id: string, state: string) => ({
  id, state, raised: '2026-08-11', title: id, how_to_test: '', feedback_count: 0,
});

test('items section into verify, open, and the collapsed rest', () => {
  const { verify, open, rest } = sectionItems([
    item('DR-001', 'implemented — verify'),
    item('DR-058', 'open'),
    item('DR-050', 'planned'),
    item('DR-008', 'partial'),
    item('NEW-1', 'new — untriaged'),
    item('DR-013', 'closed'),
    item('DR-015', 'deferred'),
  ]);
  expect(verify.map((i) => i.id)).toEqual(['DR-001']);
  expect(open.map((i) => i.id)).toEqual(['DR-058', 'DR-050', 'DR-008', 'NEW-1']);
  expect(rest.map((i) => i.id)).toEqual(['DR-013', 'DR-015']);
});

test('an unknown future state lands in rest, never lost', () => {
  const { verify, open, rest } = sectionItems([item('DR-099', 'implementation ready — review')]);
  expect(verify).toHaveLength(0);
  expect(open).toHaveLength(0);
  expect(rest.map((i) => i.id)).toEqual(['DR-099']);
});
