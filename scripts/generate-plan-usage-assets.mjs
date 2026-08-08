import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/design-references/plan-usage-2026-08');
fs.mkdirSync(OUT, { recursive: true });

const themes = {
  light: {
    bg: '#F3F1EA', glow: '#ECE9DF', surface: '#FBFAF6', elevated: '#FFFFFF',
    line: '#D9D9D2', line2: '#B9BDC4', text: '#1C2129', muted: '#5D6879',
    mint: '#15795F', mintInk: '#F5FBF8', violet: '#6A55E0', violetWash: '#EFECFB',
    amber: '#8F6411', amberWash: '#F6F0E3', amberLine: '#B99C65', scrim: '#14182073',
  },
  dark: {
    bg: '#0B0D12', glow: '#11141C', surface: '#151922', elevated: '#1B202B',
    line: '#2A2F3A', line2: '#454C5B', text: '#F3F0E8', muted: '#99A3B7',
    mint: '#65D6B4', mintInk: '#0A231B', violet: '#9B8AFB', violetWash: '#29263D',
    amber: '#E4B85C', amberWash: '#2B261B', amberLine: '#6B5935', scrim: '#0000008C',
  },
};

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x, y, value, size, fill, weight = 400, family = 'Manrope', anchor = 'start', extra = '') =>
  `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}, ${family === 'Newsreader' ? 'Georgia, serif' : 'Arial, sans-serif'}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" ${extra}>${esc(value)}</text>`;
const lines = (x, y, values, size, fill, lineHeight = 20, weight = 400, family = 'Manrope', anchor = 'start') =>
  values.map((v, i) => text(x, y + i * lineHeight, v, size, fill, weight, family, anchor)).join('');
const rect = (x, y, w, h, r, fill, stroke = 'none', sw = 0) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const line = (x1, y1, x2, y2, stroke, sw = 1, dash = '') =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
const circle = (cx, cy, r, fill, stroke = 'none', sw = 0) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;

function icon(kind, x, y, color, size = 22) {
  const s = size / 24;
  const p = (d, fill = 'none') => `<path data-kind="${kind}" data-x="${x}" data-y="${y}" data-size="${size}" d="${d}" fill="${fill}" stroke="${color}" stroke-width="${1.8 / s}" stroke-linecap="round" stroke-linejoin="round" transform="translate(${x} ${y}) scale(${s})"/>`;
  if (kind === 'back') return p('M15 18l-6-6 6-6');
  if (kind === 'chevron') return p('M9 18l6-6-6-6');
  if (kind === 'calendar') return p('M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 011 1v14H4V6a1 1 0 011-1z');
  if (kind === 'clock') return p('M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0');
  if (kind === 'audio') return p('M4 14v-4a8 8 0 0116 0v4M4 14h3v6H5a1 1 0 01-1-1v-5zM20 14h-3v6h2a1 1 0 001-1v-5z');
  if (kind === 'book') return p('M4 5.5A3.5 3.5 0 017.5 2H12v18H7.5A3.5 3.5 0 004 23V5.5zM20 5.5A3.5 3.5 0 0016.5 2H12v18h4.5A3.5 3.5 0 0120 23V5.5z');
  if (kind === 'spark') return p('M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z');
  if (kind === 'settings') return p('M12 8a4 4 0 100 8 4 4 0 000-8zM4.9 7l-1.4 2.4 1.7 1a7 7 0 000 3.2l-1.7 1L4.9 17l1.7-1a7 7 0 002.8 1.6v2h2.8v-2a7 7 0 002.8-1.6l1.7 1 1.4-2.4-1.7-1a7 7 0 000-3.2l1.7-1L18.7 7 17 8a7 7 0 00-2.8-1.6v-2h-2.8v2A7 7 0 008.6 8L6.9 7z');
  return p('M12 3v10M12 18v.01');
}

function chrome(t, title) {
  return `${rect(0, 0, 393, 852, 0, t.bg)}
    ${circle(320, 210, 154, t.glow)}
    ${text(28, 31, '8:08', 14, t.text, 700)}
    ${text(365, 31, '83%', 13, t.text, 700, 'Manrope', 'end')}
    ${line(300, 27, 304, 23, t.text, 2)}${line(307, 27, 311, 19, t.text, 2)}${line(314, 27, 318, 15, t.text, 2)}
    ${rect(326, 19, 20, 11, 2, 'none', t.text, 1.3)}${rect(347, 22, 2, 5, 1, t.text)}
    ${rect(328, 21, 14, 7, 1, t.text)}
    ${circle(48, 93, 26, t.elevated, t.line, 1)}${icon('back', 36, 81, t.text, 24)}
    ${text(196.5, 99, title, 20, t.mint, 600, 'Manrope', 'middle')}
    ${line(0, 135, 393, 135, t.line, 1)}
    ${rect(147, 830, 99, 4, 2, t.text)}`;
}

function progress(t, fraction, warn = false) {
  const x = 40, y = 388, w = 313;
  const f = Math.max(0, Math.min(1, fraction));
  return `${rect(x, y, w, 10, 5, t.line)}${rect(x, y, w * f, 10, 5, t.violet)}
    ${line(x + w * .8, y - 4, x + w * .8, y + 14, warn ? t.amber : t.muted, 1)}
    ${text(x + w * .8, y + 29, 'heads-up', 11, warn ? t.amber : t.muted, 600, 'Manrope', 'middle')}`;
}

function planDetail(themeName, state) {
  const t = themes[themeName];
  const approaching = state === 'approaching';
  const fraction = approaching ? .84 : .18;
  const pct = approaching ? '84%' : '18%';
  const plan = approaching ? 'BASIC' : 'TESTER';
  const summary = approaching
    ? ['20 papers a month,', '45 minutes of studio narration']
    : ['Testing plan — generous allowance', 'while the app is in review'];
  let s = chrome(t, 'Plan & usage');
  s += text(20, 176, 'Your allowance', 30, t.text, 500, 'Newsreader');
  s += rect(20, 194, 76, 28, 14, t.violetWash, t.violet, 1);
  s += text(58, 213, plan, 11, t.violet, 700, 'Manrope', 'middle', 'letter-spacing="1.2"');
  s += lines(20, 247, summary, 15, t.muted, 21, 400);
  s += rect(20, 292, 353, 210, 26, t.surface, t.line, 1);
  s += text(40, 322, 'USED THIS MONTH', 11, t.muted, 700, 'Manrope', 'start', 'letter-spacing="1.3"');
  s += text(40, 372, pct, 42, t.text, 500, 'Newsreader');
  s += text(353, 365, approaching ? 'close to the limit' : 'spent', 13, t.muted, 500, 'Manrope', 'end');
  s += progress(t, fraction, approaching);
  s += line(40, 432, 353, 432, t.line, 1);
  s += icon('calendar', 40, 449, t.muted, 20);
  s += text(70, 465, 'Resets September 1', 14, t.text, 600);
  s += text(70, 487, 'Usage starts fresh each month.', 13, t.muted);
  if (approaching) {
    s += rect(20, 518, 353, 116, 20, t.amberWash, t.amberLine, 1);
    s += circle(47, 547, 15, t.amberWash, t.amber, 1);
    s += text(47, 552, 'i', 15, t.amber, 700, 'Newsreader', 'middle');
    s += text(72, 550, "You're getting close", 15, t.text, 700);
    s += lines(40, 582, ['Nothing is blocked. Scholiast will keep working', "until this month's allowance is used."], 13, t.muted, 20);
    s += rect(20, 650, 353, 100, 20, t.surface, t.line, 1);
    s += icon('spark', 40, 674, t.violet, 21);
    s += text(72, 690, 'Your Basic plan', 14, t.text, 700);
    s += text(40, 722, '20 papers a month · 45 min studio voice', 13, t.muted);
  } else {
    s += rect(20, 518, 353, 128, 20, t.amberWash, t.amberLine, 1);
    s += circle(48, 550, 6, t.amber);
    s += circle(64, 550, 4, t.amber);
    s += circle(77, 550, 3, t.amber);
    s += text(94, 554, 'IN PROGRESS NOW', 11, t.amber, 700, 'Manrope', 'start', 'letter-spacing="1.2"');
    s += text(40, 588, 'Some work is finishing', 15, t.text, 700);
    s += lines(40, 616, ['A little room is temporarily set aside. It returns', 'as the work finishes.'], 13, t.muted, 20);
    s += rect(20, 662, 353, 88, 20, t.surface, t.line, 1);
    s += icon('spark', 40, 682, t.violet, 21);
    s += text(72, 698, 'Testing plan', 14, t.text, 700);
    s += text(40, 728, 'Studio narration included', 13, t.muted);
  }
  return wrapSvg(s, `${state} ${themeName}`);
}

function discussionBase(t) {
  let s = `${rect(0, 0, 393, 852, 0, t.bg)}${circle(320, 210, 154, t.glow)}
    ${text(28, 31, '8:08', 14, t.text, 700)}${text(365, 31, '83%', 13, t.text, 700, 'Manrope', 'end')}
    ${circle(48, 93, 26, t.elevated, t.line, 1)}${icon('back', 36, 81, t.text, 24)}
    ${text(198, 90, 'DistServe: Disaggregating…', 16, t.mint, 600, 'Manrope', 'middle')}
    ${text(198, 113, '2024', 13, t.muted, 400, 'Manrope', 'middle')}${line(0, 135, 393, 135, t.line)}
    ${text(20, 179, 'Synthesis changes', 26, t.text, 500, 'Newsreader')}
    ${lines(20, 215, ['Since this is the first paper we have read, the synthesis', 'is being created from scratch. It establishes DistServe', 'as the reference point for the disaggregation thread.', '', 'The paper separates prefill from decoding and traces', 'how scheduling, memory and placement shape throughput.'], 17, t.text, 27, 400, 'Newsreader')}
    ${rect(14, 770, 365, 58, 29, t.elevated, t.line2, 1)}${text(28, 805, 'Reply', 16, t.muted)}
    ${line(338, 808, 352, 794, t.muted, 2)}${line(352, 794, 366, 808, t.muted, 2)}${rect(147, 837, 99, 4, 2, t.text)}`;
  return s;
}

function modal(themeName, state) {
  const t = themes[themeName];
  const config = {
    exhausted: {
      icon: 'calendar', accent: t.violet, wash: t.violetWash, title: "This month's allowance is used",
      body: ['Paid work is paused until September 1.', 'Reading, notes, and device voice still work.'],
      detail: 'Resets September 1', primary: 'Keep reading', secondary: 'View plan & usage', y: 352, height: 452,
    },
    busy: {
      icon: 'clock', accent: t.amber, wash: t.amberWash, title: 'A few things are finishing',
      body: ['Work already running has a little room', 'set aside. That room returns within seconds', 'when it finishes.'],
      detail: 'Nothing is exhausted', primary: 'Try again in 15s', secondary: 'Not now', y: 320, height: 452,
    },
    'too-large': {
      icon: 'audio', accent: t.violet, wash: t.violetWash, title: "This narration won't fit your plan",
      body: ['A studio-voice version is larger than', "the Free plan's whole monthly allowance.", "Waiting won't help."],
      detail: 'Device voice is included', primary: 'Use device voice', secondary: 'Not now', y: 300, height: 476,
    },
  }[state];
  let s = discussionBase(t);
  s += rect(0, 0, 393, 852, 0, t.scrim);
  const y = config.y;
  s += rect(20, y, 353, config.height, 30, t.elevated, config.accent, 1.2);
  s += rect(170, y + 13, 53, 4, 2, t.line2);
  s += circle(64, y + 71, 28, config.wash);
  s += icon(config.icon, 52, y + 59, config.accent, 24);
  s += lines(40, y + 126, wrapTitle(config.title), 28, t.text, 31, 500, 'Newsreader');
  const bodyY = y + (config.title.length > 30 ? 202 : 174);
  s += lines(40, bodyY, config.body, 14, t.muted, 22, 400);
  const detailY = bodyY + config.body.length * 22 + 14;
  s += rect(40, detailY, 313, 54, 16, config.wash, config.accent, .8);
  s += circle(62, detailY + 27, 5, config.accent);
  s += text(78, detailY + 32, config.detail, 13, config.accent, 700);
  s += rect(40, detailY + 74, 313, 56, 28, t.mint);
  s += text(196.5, detailY + 109, config.primary, 15, t.mintInk, 700, 'Manrope', 'middle');
  s += text(196.5, detailY + 162, config.secondary, 14, t.mint, 700, 'Manrope', 'middle');
  return wrapSvg(s, `${state} ${themeName}`);
}

function wrapTitle(value) {
  if (value === "This month's allowance is used") return ["This month's allowance", 'is used'];
  if (value === "This narration won't fit your plan") return ["This narration won't fit", 'your plan'];
  return [value];
}

function settings(themeName, enforced) {
  const t = themes[themeName];
  let s = chrome(t, 'Settings');
  s += text(20, 170, 'ACCOUNT', 11, t.muted, 700, 'Manrope', 'start', 'letter-spacing="1.3"');
  const h = enforced ? 188 : 126;
  s += rect(20, 188, 353, h, 24, t.surface, t.line, 1);
  s += circle(52, 225, 20, t.violetWash);
  s += text(52, 230, 'K', 15, t.violet, 700, 'Newsreader', 'middle');
  s += text(84, 219, 'Kamil', 15, t.text, 700);
  s += text(84, 241, 'Signed in', 13, t.muted);
  if (enforced) {
    s += line(40, 263, 353, 263, t.line);
    s += circle(52, 302, 20, t.violetWash);
    s += icon('spark', 41, 291, t.violet, 22);
    s += text(84, 296, 'Plan & usage', 15, t.text, 700);
    s += text(84, 319, 'Testing plan', 13, t.muted);
    s += icon('chevron', 337, 289, t.muted, 20);
  } else {
    s += line(40, 263, 353, 263, t.line);
    s += text(40, 301, 'Sign out', 15, t.mint, 700);
  }
  const py = enforced ? 406 : 344;
  s += text(20, py, 'READING', 11, t.muted, 700, 'Manrope', 'start', 'letter-spacing="1.3"');
  s += rect(20, py + 18, 353, 218, 24, t.surface, t.line, 1);
  const rows = [
    ['Reading mode', 'Balanced'], ['Narration voice', 'Nova'], ['Theme', themeName === 'light' ? 'Light' : 'Dim'],
  ];
  rows.forEach((row, i) => {
    const yy = py + 58 + i * 66;
    s += text(40, yy, row[0], 15, t.text, 700);
    s += text(353, yy, row[1], 13, t.muted, 500, 'Manrope', 'end');
    if (i < 2) s += line(40, yy + 25, 353, yy + 25, t.line);
  });
  s += text(20, py + 274, 'SUPPORT & LEGAL', 11, t.muted, 700, 'Manrope', 'start', 'letter-spacing="1.3"');
  s += rect(20, py + 292, 353, 126, 24, t.surface, t.line, 1);
  s += text(40, py + 335, 'Privacy policy', 15, t.text, 700);
  s += icon('chevron', 337, py + 321, t.muted, 20);
  s += line(40, py + 354, 353, py + 354, t.line);
  s += text(40, py + 393, 'Terms of service', 15, t.text, 700);
  s += icon('chevron', 337, py + 379, t.muted, 20);
  return wrapSvg(s, `${enforced ? 'settings-entry' : 'not-enforced'} ${themeName}`);
}

function wrapSvg(content, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="393" height="852" viewBox="0 0 393 852" role="img" aria-label="${esc(label)}">
  <title>${esc(label)}</title>
  ${content}
</svg>\n`;
}

const assets = {
  '00-settings-entry': settings,
  '01-normal': planDetail,
  '02-approaching': planDetail,
  '03-exhausted': modal,
  '04-busy-not-exhausted': modal,
  '05-too-large': modal,
  '06-not-enforced': (themeName) => settings(themeName, false),
};

for (const themeName of Object.keys(themes)) {
  for (const [name, render] of Object.entries(assets)) {
    let svg;
    if (name === '00-settings-entry') svg = render(themeName, true);
    else if (name === '01-normal') svg = render(themeName, 'normal');
    else if (name === '02-approaching') svg = render(themeName, 'approaching');
    else if (name === '03-exhausted') svg = render(themeName, 'exhausted');
    else if (name === '04-busy-not-exhausted') svg = render(themeName, 'busy');
    else if (name === '05-too-large') svg = render(themeName, 'too-large');
    else svg = render(themeName);
    fs.writeFileSync(path.join(OUT, `${name}-${themeName}.svg`), svg);
  }
}

fs.writeFileSync(path.join(OUT, 'README.md'), `# Scholiast plan and usage exports\n\nGenerated by \`scripts/generate-plan-usage-assets.mjs\` and rasterized for review by \`scripts/render-plan-usage-assets.py\`. Each SVG/PNG pair is a 393 × 852 Android frame.\n\n- \`00-settings-entry\`: enforced Settings entry point\n- \`01-normal\`: comfortable month-to-date spend, with held work treated separately\n- \`02-approaching\`: server warning at or above 80% spend\n- \`03-exhausted\`: persistent monthly refusal shown mid-flow\n- \`04-busy-not-exhausted\`: transient hold collision shown mid-flow\n- \`05-too-large\`: one action larger than the whole Free allowance\n- \`06-not-enforced\`: Settings with every allowance surface omitted\n- \`contact-sheet-light/dark.png\`: final screenshot review sheets\n\nLight and dark exports use the production tokens in \`mobile/src/theme/tokens.ts\`. All visible text uses the packaged Manrope and Newsreader fonts.\n`);
