import fs from 'fs';
import path from 'path';

// PaperEntityProvider renders RelatedWorksSheet as a sibling after `children`, not inside them.
// The Gorhom modal provider therefore has to wrap PaperEntityProvider itself; putting it around
// only ThemedShell compiles and passes mocked component tests but crashes on native launch with
// "BottomSheetModalInternalContext cannot be null".
test('the bottom-sheet modal provider wraps the app-wide paper entity sheet', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'app', '_layout.tsx'),
    'utf8',
  );
  const modalOpen = source.indexOf('<BottomSheetModalProvider>');
  const paperOpen = source.indexOf('<PaperEntityProvider>');
  const paperClose = source.indexOf('</PaperEntityProvider>');
  const modalClose = source.indexOf('</BottomSheetModalProvider>');

  expect(modalOpen).toBeGreaterThan(-1);
  expect(paperOpen).toBeGreaterThan(modalOpen);
  expect(paperClose).toBeGreaterThan(paperOpen);
  expect(modalClose).toBeGreaterThan(paperClose);
});
