const fs = require('fs');
const path = require('path');

// Compatibility patches for react-native-track-player 4.1.2 on React Native 0.85 / Expo SDK 56
// (New Architecture). Two independent fixes, both in MusicModule.kt:
//
//  1) Kotlin compile: RN 0.85's Arguments.fromBundle expects a non-null Bundle, while RNTP's
//     originalItem is Bundle?. Make those calls null-safe.
//
//  2) TurboModule interop runtime crash (SIGABRT on launch): the interop rejects any @ReactMethod
//     whose return type isn't void. RNTP declares many methods with a Kotlin expression body,
//     `fun foo(...) = scope.launch { ... }`, whose inferred return type is Job (non-void), so the
//     module fails to initialize -> uncaught JS error -> native abort. Convert those expression
//     bodies into Unit-returning block bodies: `fun foo(...) { scope.launch { ... } }`.
//
// Reanimated v4 forces the New Architecture on, so disabling it isn't an option; this patch is.

const file = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-track-player',
  'android',
  'src',
  'main',
  'java',
  'com',
  'doublesymmetry',
  'trackplayer',
  'module',
  'MusicModule.kt'
);

if (!fs.existsSync(file)) {
  console.warn('[patch-rntp] MusicModule.kt not found; skipping');
  process.exit(0);
}

let source = fs.readFileSync(file, 'utf8');
const original = source;

// ---------- Fix 2: expression-body coroutine methods -> Unit block bodies ----------
// Find the matching close brace for the `{` at openIndex, skipping Kotlin strings, char
// literals, and comments so braces inside them aren't miscounted.
function matchingBrace(src, openIndex) {
  let depth = 0;
  let i = openIndex;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Anchor on the `)` that closes a method's parameter list, then `= scope.launch {`.
const exprBody = /\)\s*=\s*scope\.launch\s*\{/g;
const opens = [];
let m;
while ((m = exprBody.exec(source)) !== null) {
  const braceIndex = m.index + m[0].length - 1; // index of scope.launch's `{`
  opens.push({ start: m.index, matchLen: m[0].length, braceIndex });
}

let converted = 0;
// Process right-to-left so earlier indices stay valid as we splice in braces.
for (let k = opens.length - 1; k >= 0; k--) {
  const { start, matchLen, braceIndex } = opens[k];
  const close = matchingBrace(source, braceIndex);
  if (close === -1) {
    console.warn('[patch-rntp] could not find matching brace; skipping one method');
    continue;
  }
  // 1) close the new fun body just after the launch lambda's closing brace.
  source = source.slice(0, close + 1) + '\n    }' + source.slice(close + 1);
  // 2) open the fun body in place of the expression-body `=`.
  source =
    source.slice(0, start) + ') {\n        scope.launch {' + source.slice(start + matchLen);
  converted++;
}
if (converted) {
  console.log(`[patch-rntp] converted ${converted} expression-body coroutine method(s) to Unit block bodies`);
} else if (!exprBody.test(original)) {
  console.log('[patch-rntp] expression-body methods already converted');
}

// ---------- Fix 1: null-safe Arguments.fromBundle ----------
source = source.replace(
  'callback.resolve(Arguments.fromBundle(musicService.tracks[index].originalItem))',
  'callback.resolve(musicService.tracks[index].originalItem?.let { Arguments.fromBundle(it) })'
);
source = source.replace(
  /else Arguments\.fromBundle\(\s*musicService\.tracks\[musicService\.getCurrentTrackIndex\(\)\]\.originalItem\s*\)/,
  'else musicService.tracks[musicService.getCurrentTrackIndex()].originalItem?.let { Arguments.fromBundle(it) }'
);

if (source !== original) {
  fs.writeFileSync(file, source);
  console.log('[patch-rntp] Applied RN 0.85 / New Architecture compatibility patches to MusicModule.kt');
} else {
  console.log('[patch-rntp] MusicModule.kt: no changes (already patched)');
}

// ---------- Fix 3: MusicService.kt event emission under New Architecture ----------
// RNTP emits JS events via `reactNativeHost.reactInstanceManager.currentReactContext`, but
// under the New Architecture accessing reactNativeHost throws ("You should not use
// ReactNativeHost directly in the New Architecture"), crashing the playback service the moment
// it emits an event. Resolve the ReactContext via reactHost (bridgeless/new-arch), falling back
// to reactNativeHost only when reactHost is null (old arch). Fully-qualified names -> no imports.
const svc = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-track-player',
  'android',
  'src',
  'main',
  'java',
  'com',
  'doublesymmetry',
  'trackplayer',
  'service',
  'MusicService.kt'
);

if (!fs.existsSync(svc)) {
  console.warn('[patch-rntp] MusicService.kt not found; skipping');
} else {
  let s = fs.readFileSync(svc, 'utf8');
  const before = s;

  if (s.includes('private fun currentReactContext(')) {
    console.log('[patch-rntp] MusicService.kt: already patched');
  } else {
    // 1) Route both emit paths through a new-arch-safe helper.
    s = s.split('reactNativeHost.reactInstanceManager.currentReactContext').join('currentReactContext()');

    // 2) Insert the helper just before the first emit() function.
    const helper =
      '    private fun currentReactContext(): com.facebook.react.bridge.ReactContext? {\n' +
      '        val app = applicationContext as? com.facebook.react.ReactApplication ?: return null\n' +
      '        val host = app.reactHost\n' +
      '        return if (host != null) host.currentReactContext\n' +
      '        else app.reactNativeHost.reactInstanceManager.currentReactContext\n' +
      '    }\n\n';
    const anchor = '    private fun emit(event: String, data: Bundle? = null) {';
    if (s.includes(anchor)) {
      s = s.replace(anchor, helper + anchor);
    } else {
      console.warn('[patch-rntp] MusicService.kt: emit() anchor not found; helper not inserted');
    }

    if (s !== before) {
      fs.writeFileSync(svc, s);
      console.log('[patch-rntp] Applied New Architecture event-emission patch to MusicService.kt');
    } else {
      console.warn('[patch-rntp] MusicService.kt: expected patterns not found; patch may need updating');
    }
  }
}
