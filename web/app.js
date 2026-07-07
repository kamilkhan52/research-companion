"use strict";

/* ---------------- auth ----------------
 * Mode comes from the backend (/api/auth/config): "supabase" | "token" | "open".
 *  - supabase: real user login (Google + email magic-link) via supabase-js; the access token
 *    is sent as Bearer on fetch and as ?token= on <audio>/download/SSE tags.
 *  - token: legacy shared secret — open the app once with ?token=… (saved + stripped from URL).
 *  - open: no auth (local/tunnel default). */
const Auth = { mode: "open", sb: null, accessToken: "", email: "" };

// Legacy shared-token capture (token mode): ?token=… → saved and removed from the address bar.
(function captureToken() {
  const u = new URL(window.location.href);
  const t = u.searchParams.get("token");
  if (t) { localStorage.setItem("rc_token", t); u.searchParams.delete("token");
    history.replaceState(null, "", u.pathname + u.search + u.hash); }
})();

function authToken() { return Auth.accessToken || localStorage.getItem("rc_token") || ""; }
function authHeaders(h = {}) { const t = authToken(); if (t) h["Authorization"] = "Bearer " + t; return h; }
function withTok(url) { const t = authToken(); if (!t) return url; return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t); }

function applySession(session) {
  Auth.accessToken = (session && session.access_token) || "";
  Auth.email = (session && session.user && session.user.email) || "";
  // If a session arrives while the login screen is up (OAuth/magic-link return), enter the app.
  if (Auth.accessToken && document.querySelector(".auth-panel")) loadLibrary();
  const so = document.getElementById("signOutRow");
  if (so) so.classList.toggle("hidden", !Auth.accessToken);
}

async function initAuth() {
  let cfg; try { cfg = await api("/api/auth/config"); } catch (e) { cfg = { mode: "open" }; }
  Auth.mode = cfg.mode || "open";
  if (Auth.mode !== "supabase") return;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  Auth.sb = createClient(cfg.supabase_url, cfg.supabase_anon_key,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const { data } = await Auth.sb.auth.getSession();
  applySession(data.session);
  Auth.sb.auth.onAuthStateChange((_e, session) => applySession(session));
}

function needLogin() { return Auth.mode === "supabase" && !Auth.accessToken; }

function renderLogin() {
  setTitle("Reading Companion", false);
  $app.innerHTML =
    '<div class="panel auth-panel"><h3>Sign in</h3>' +
    '<p class="muted">Sign in to use your research companion.</p>' +
    '<button id="googleBtn" class="primary">Continue with Google</button>' +
    '<div class="auth-or">or</div>' +
    '<label class="field"><span>Email</span>' +
    '<input id="authEmail" type="email" placeholder="you@example.com" autocomplete="email" /></label>' +
    '<button id="magicBtn" class="ghost">Email me a magic link</button>' +
    '<small id="authMsg" class="muted"></small></div>';
  document.getElementById("googleBtn").onclick = signInGoogle;
  document.getElementById("magicBtn").onclick = signInMagic;
}

async function signInGoogle() {
  try { await Auth.sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } }); }
  catch (e) { toast(e.message); }
}
async function signInMagic() {
  const email = (document.getElementById("authEmail").value || "").trim();
  if (!email) { toast("Enter your email first."); return; }
  const { error } = await Auth.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
  document.getElementById("authMsg").textContent =
    error ? error.message : "Check your email for the sign-in link.";
}
async function signOut() {
  try { if (Auth.sb) await Auth.sb.auth.signOut(); } catch (e) {}
  Auth.accessToken = ""; location.reload();
}

/* ---------------- API ---------------- */
async function api(path, method = "GET", body = null) {
  const opt = { method, headers: authHeaders({}) };
  if (body) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  let data = null;
  try { data = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok) throw new Error((data && data.detail) || ("HTTP " + r.status));
  return data;
}

function toast(msg, ms = 4200) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

/* ---------------- mini markdown ---------------- */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function mdInline(s) {
  s = s.replace(/`([^`]+)`/g, (m, c) => "<code>" + c + "</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function mdToHtml(src) {
  const blocks = [];
  src = src.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m.replace(/^```\w*\n?/, "").replace(/```$/, ""));
    return "@@CODE" + (blocks.length - 1) + "@@";
  });
  src = escapeHtml(src);
  const lines = src.split("\n");
  let html = "", listType = null, para = [];
  const flushPara = () => { if (para.length) { html += "<p>" + mdInline(para.join(" ")) + "</p>"; para = []; } };
  const flushList = () => { if (listType) { html += "</" + listType + ">"; listType = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const code = line.match(/^@@CODE(\d+)@@$/);
    if (code) { flushPara(); flushList(); html += "<pre><code>" + escapeHtml(blocks[+code[1]]) + "</code></pre>"; continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); flushList(); const l = h[1].length; html += "<h" + l + ">" + mdInline(h[2]) + "</h" + l + ">"; continue; }
    if (/^>\s?/.test(line)) { flushPara(); flushList(); html += "<blockquote>" + mdInline(line.replace(/^>\s?/, "")) + "</blockquote>"; continue; }
    const ol = line.match(/^\d+\.\s+(.*)$/), ul = line.match(/^[-*]\s+(.*)$/);
    if (ol || ul) { flushPara(); const t = ol ? "ol" : "ul"; if (listType !== t) { flushList(); html += "<" + t + ">"; listType = t; } html += "<li>" + mdInline((ol || ul)[1]) + "</li>"; continue; }
    para.push(line);
  }
  flushPara(); flushList();
  return html;
}

/* ---------------- TTS (Web Speech API) ---------------- */
const TTS = {
  speaking: false, btn: null,
  voices: [], voiceURI: localStorage.getItem("rc_voice") || "",
  rate: parseFloat(localStorage.getItem("rc_rate") || "1"),
  loadVoices() {
    this.voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    return this.voices;
  },
  pickVoice() {
    if (!this.voices.length) this.loadVoices();
    let v = this.voices.find((x) => x.voiceURI === this.voiceURI);
    if (!v) v = this.voices.find((x) => /en[-_]/i.test(x.lang) && /US|GB/i.test(x.lang));
    if (!v) v = this.voices.find((x) => /^en/i.test(x.lang));
    return v || this.voices[0] || null;
  },
  chunk(text) {
    text = text.replace(/\s*\n\s*/g, " ").trim();
    // Protect dotted initialisms ("O.P.T." / "O.P.T") so their dots are never split points.
    text = text.replace(/(?:[A-Z]\.){2,}/g, (m) => m.split(".").join("<<DOT>>"));
    // Split only on a terminator FOLLOWED BY whitespace/end, so "3.1" (no following space)
    // also stays in one piece.
    const raw = text.match(/.+?[.!?]+(?=\s|$)|.+$/g) || [text];
    const out = [];
    for (let s of raw) {
      s = s.split("<<DOT>>").join(".").trim(); if (!s) continue;
      while (s.length > 220) { let cut = s.lastIndexOf(",", 220); if (cut < 60) cut = 220; out.push(s.slice(0, cut).trim()); s = s.slice(cut).trim(); }
      out.push(s);
    }
    return out;
  },
  speak(text, btn, opts) {
    if (!window.speechSynthesis) { toast("This browser has no speech synthesis."); return; }
    this.stop();
    const chunks = this.chunk(text);
    const voice = this.pickVoice();
    this.speaking = true; this.btn = btn; this.opts = opts || {}; this._setBtn(true);
    let i = 0;
    const next = () => {
      if (!this.speaking || i >= chunks.length) { this.stop(); return; }
      const idx = i;
      const u = new SpeechSynthesisUtterance(chunks[idx]);
      if (voice) u.voice = voice;
      u.rate = this.rate; u.pitch = 1;
      u.onstart = () => { if (this.opts && this.opts.onChunk) this.opts.onChunk(idx); };
      u.onend = () => { i++; next(); };
      u.onerror = () => { i++; next(); };
      speechSynthesis.speak(u);
    };
    next();
  },
  stop() {
    const opts = this.opts;
    this.speaking = false;
    if (window.speechSynthesis) speechSynthesis.cancel();
    this._setBtn(false); this.btn = null; this.opts = null;
    if (opts && opts.onDone) opts.onDone();
  },
  _setBtn(on) {
    document.querySelectorAll(".listen").forEach((b) => { b.classList.remove("playing"); b.textContent = "▶︎ Listen"; });
    if (on && this.btn) { this.btn.classList.add("playing"); this.btn.textContent = "■ Stop"; }
  },
};
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => TTS.loadVoices();

/* ---------------- audio control ----------------
 * OpenAI speech plays as ONE complete mp3 in a native <audio> element (robust playback with
 * play/pause/resume/seek, plus download). Browser speech uses the Web Speech chunk player (TTS)
 * with sentence read-along. */
function stopAllAudio() {
  TTS.stop();
  document.querySelectorAll("audio.tts-audio").forEach((a) => { try { a.pause(); } catch (e) {} });
}

/* ---------------- app state + views ---------------- */
const S = { papers: [], projects: [], hasKey: false, model: "", narrationModel: "", speechProvider: "openai", view: "library", slug: null, autoplay: false, turns: [] };
const REVIEW_SLUG = "_review", REVIEW_TITLE = "Working Notes Review";

/* Active research project. All per-project API calls go through pp(); global calls (settings,
 * models, prompts, speak/narrate) keep their plain /api/… path. */
let PROJECT = localStorage.getItem("rc_project") || "";
function pp(sub) { return "/api/projects/" + encodeURIComponent(PROJECT) + sub; }
function setProject(pid) { PROJECT = pid; localStorage.setItem("rc_project", pid); }

// Load the project list and make sure PROJECT points at a real one (default: first). Returns
// false when there are no projects yet (caller shows the create-first-project screen).
async function ensureProject() {
  const r = await api("/api/projects");
  S.projects = r.projects || [];
  if (!S.projects.length) { PROJECT = ""; return false; }
  if (!PROJECT || !S.projects.some((p) => p.id === PROJECT)) setProject(S.projects[0].id);
  return true;
}
const $app = document.getElementById("app");
const $title = document.getElementById("title");
const $back = document.getElementById("backBtn");

function setTitle(t, back) {
  $title.textContent = t;
  $back.classList.toggle("hidden", !back);
}

const STATE_LABEL = { read: "read", in_discussion: "in discussion", notes_drafted: "notes drafted", unread: "unread", committed: "read", retrieving: "retrieving" };
function paperStatus(p) {
  if (p.list_status === "read" || p.session_state === "committed") return "read";
  if (p.session_state) return p.session_state;
  return "unread";
}

function projectBarHtml() {
  const opts = S.projects.map((p) =>
    '<option value="' + p.id + '"' + (p.id === PROJECT ? " selected" : "") + ">" +
    escapeHtml(p.name) + " (" + p.read_count + "/" + p.paper_count + ")</option>").join("");
  return '<div class="project-bar">' +
    '<select id="projectSelect" aria-label="Active project">' + opts + "</select>" +
    '<button id="newProjectBtn" class="ghost" aria-label="New project">+ New</button></div>';
}

function wireProjectBar() {
  const sel = document.getElementById("projectSelect");
  if (sel) sel.onchange = (e) => { setProject(e.target.value); loadLibrary(); };
  const nb = document.getElementById("newProjectBtn");
  if (nb) nb.onclick = createProjectFlow;
}

async function createProjectFlow() {
  const name = (window.prompt("Name your new research project:") || "").trim();
  if (!name) return;
  let res; try { res = await api("/api/projects", "POST", { name }); }
  catch (e) { toast(e.message); return; }
  setProject(res.project.id);
  toast("Created “" + res.project.name + "”");
  loadLibrary();
}

function renderNoProjects() {
  setTitle("Reading Companion", false);
  $app.innerHTML =
    '<div class="panel"><h3>Create your first project</h3>' +
    '<p class="muted">A project holds one reading list, its corpus, sessions, and working notes.</p>' +
    '<button id="firstProjectBtn" class="primary">+ New project</button></div>';
  document.getElementById("firstProjectBtn").onclick = createProjectFlow;
}

async function loadLibrary() {
  stopAllAudio();
  setTitle("Reading Companion", false);
  $app.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading reading list…</div>';
  let hasProj;
  try { hasProj = await ensureProject(); } catch (e) { $app.innerHTML = ""; toast(e.message); return; }
  if (!hasProj) return renderNoProjects();
  let st;
  try { st = await api(pp("/state")); } catch (e) { $app.innerHTML = ""; toast(e.message); return; }
  S.papers = st.papers; S.hasKey = st.has_key; S.model = st.model; S.narrationModel = st.narration_model;
  S.speechProvider = st.speech_provider || "openai";
  S.view = "library"; S.slug = null;
  if (S.speechProvider === "openai" && !st.has_openai_key)
    toast("Speech is set to OpenAI — add your OpenAI key in Settings → Speech (or switch to Browser).", 6500);
  if (!st.has_key) toast("Add your OpenRouter key in Settings (⚙) to start a paper.", 6000);

  const readCount = st.papers.filter((p) => p.list_status === "read").length;
  let html = projectBarHtml() +
    '<div class="card review-card" data-slug="' + REVIEW_SLUG + '">' +
    '<div class="ct"><div class="t">◆ Working Notes Review</div>' +
    '<div class="s">cross-paper synthesis of all ' + readCount + ' read so far</div></div>' +
    '<span class="badge review-badge">review</span></div>';

  const groups = {};
  for (const p of st.papers) { (groups[p.group] = groups[p.group] || []).push(p); }
  for (const g of Object.keys(groups)) {
    html += '<div class="group-title">' + escapeHtml(g) + "</div>";
    for (const p of groups[g]) {
      const stt = paperStatus(p);
      html += '<div class="card" data-slug="' + p.slug + '">' +
        '<div class="ct"><div class="t">' + escapeHtml(p.title) + "</div>" +
        '<div class="s">' + escapeHtml(p.slug) + "</div></div>" +
        '<span class="badge ' + stt + '">' + (STATE_LABEL[stt] || stt) + "</span></div>";
    }
  }
  $app.innerHTML = html;
  wireProjectBar();
  $app.querySelectorAll(".card").forEach((c) => c.onclick = () => openPaper(c.dataset.slug));
}

async function openPaper(slug) {
  stopAllAudio();
  S.slug = slug;
  $app.innerHTML = '<div class="loading-row"><span class="spinner"></span> Opening…</div>';
  let sess;
  try { sess = await api(pp("/session/" + slug)); } catch (e) { toast(e.message); return; }
  const p = sess.paper;
  setTitle(p.title, true);
  if (sess.state === "notes_drafted") return renderReview(slug);
  if (sess.state === "in_discussion") return renderDiscussion(p, sess.transcript);
  if (sess.transcript && sess.transcript.length) return renderDiscussion(p, sess.transcript, true);
  if (slug !== REVIEW_SLUG && !p.retrieved) return renderStart(p);  // fetch the PDF first
  return openComposeFirst(slug);                                     // editable opening + model
}

// Reusable "compose first turn" screen: editable opening prompt + model picker. Used for paper
// and review starts AND first-response retry (which simply restarts the session from here).
async function openComposeFirst(slug) {
  stopAllAudio(); removeComposer(); S.slug = slug; S.view = "compose";
  $app.innerHTML = '<div class="loading-row"><span class="spinner"></span> Preparing…</div>';
  let draft; try { draft = await api(pp("/opening_draft/" + slug)); } catch (e) { toast(e.message); return; }
  setTitle(draft.title, true); S._composeTitle = draft.title;
  const isReview = slug === REVIEW_SLUG;
  const hint = isReview
    ? "Edit the opening request and pick the model for the first response."
    : "Edit the opening prompt and pick the model for the first response. Keep <code>{full_text}</code> — the paper text is inserted there.";
  $app.innerHTML =
    '<div class="panel"><h3>' + (isReview ? "Start review" : "Start reading") + "</h3>" +
    '<p class="muted">' + hint + "</p>" +
    '<label class="field"><span>First prompt</span><textarea id="firstPrompt" class="prompt-text">' +
    escapeHtml(draft.prompt) + "</textarea></label>" +
    '<label class="field"><span>Model for first response</span><select id="firstModel"></select></label>' +
    '<div class="btn-row"><button class="primary" id="fireBtn">▶︎ Generate first response</button></div></div>';
  fillModelSelect(document.getElementById("firstModel"), await getFavs(), draft.model);
  document.getElementById("fireBtn").onclick = () => startChat(slug);
}

async function startChat(slug) {
  const prompt = document.getElementById("firstPrompt").value;
  const model = document.getElementById("firstModel").value;
  if (model) S.model = model;
  renderDiscussion({ slug, title: S._composeTitle || "" }, []);
  const turn = await streamTurn(pp("/chat/start_stream"), { slug, prompt, model });
  if (turn && turn.proposed_commit) renderReview(slug);
}

function renderStart(p) {
  const committed = p.list_status === "read";
  $app.innerHTML =
    '<div class="panel"><h3>' + escapeHtml(p.title) + "</h3>" +
    '<p class="muted">' + (committed ? "Already read. " : "") +
    "Fetch the paper from arXiv and extract its text. You'll then edit the opening prompt and pick a model before the first response.</p>" +
    '<details><summary>Not on arXiv? Provide a source</summary>' +
    '<label class="field"><span>arXiv id (e.g. 2309.06180)</span><input id="arxivId" type="text" /></label>' +
    '<label class="field"><span>or direct PDF URL</span><input id="pdfUrl" type="text" placeholder="https://…/paper.pdf" /></label>' +
    "</details>" +
    '<button id="startBtn" class="primary">Fetch paper</button>' +
    '<div id="cands"></div></div>';
  document.getElementById("startBtn").onclick = () => doStart(p.slug);
}

async function doStart(slug, arxiv_id, pdf_url) {
  if (!arxiv_id) arxiv_id = (document.getElementById("arxivId") || {}).value || null;
  if (!pdf_url) pdf_url = (document.getElementById("pdfUrl") || {}).value || null;
  const btn = document.getElementById("startBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Fetching… (can take ~30s)"; }
  $app.insertAdjacentHTML("beforeend", '<div class="loading-row" id="startLoad"><span class="spinner"></span> Working…</div>');
  let res;
  try { res = await api(pp("/start"), "POST", { slug, arxiv_id, pdf_url }); }
  catch (e) { toast(e.message); if (btn) { btn.disabled = false; btn.textContent = "Fetch paper"; } const l = document.getElementById("startLoad"); if (l) l.remove(); return; }
  if (res.needs_confirmation) return renderCandidates(slug, res.candidates);
  openPaper(slug);  // now retrieved -> routes to the compose-first screen
}

function renderCandidates(slug, candidates) {
  const c = document.getElementById("cands") || $app;
  let html = '<p class="muted">No confident arXiv match. Pick the right paper:</p>';
  candidates.forEach((m) => {
    html += '<div class="card" data-aid="' + m.arxiv_id + '"><div class="ct"><div class="t">' +
      escapeHtml(m.title) + '</div><div class="s">arXiv:' + m.arxiv_id + " · score " + m.score.toFixed(2) + "</div></div></div>";
  });
  c.innerHTML = html;
  c.querySelectorAll(".card").forEach((el) => el.onclick = () => doStart(slug, el.dataset.aid));
}

function turnHtml(t, idx) {
  if (t.role === "user") {
    return '<div class="turn"><div class="who">You</div><div class="bubble user">' +
      mdToHtml(t.text || "") + "</div></div>";
  }
  return '<div class="turn"><div class="who">' +
    '<span>Companion' + (t.state_signal === "ready_to_draft_notes" ? ' · <span class="rd">ready to draft notes</span>' : "") + "</span></div>" +
    '<div class="bubble assistant">' + mdToHtml(t.canonical || "") +
    '<div class="audio-row"><button class="listen" data-idx="' + idx + '">▶︎ Listen</button>' +
    '<button class="transcript-toggle" data-idx="' + idx + '">Transcript</button></div>' +
    '<div class="transcript hidden" id="tr-' + idx + '"></div></div>' +
    '<div class="turn-actions"><button class="iconbtn menu" data-idx="' + idx + '" title="Retry / more" aria-label="Retry / more">⋯</button></div>' +
    "</div>";
}

function wireAudio(scope) {
  scope.querySelectorAll(".listen").forEach((b) => b.onclick = () => listen(+b.dataset.idx, b));
  scope.querySelectorAll(".transcript-toggle").forEach((b) => b.onclick = () => toggleTranscript(+b.dataset.idx, b));
  scope.querySelectorAll(".menu").forEach((b) => b.onclick = (e) => { e.stopPropagation(); openTurnMenu(+b.dataset.idx, b); });
}

// Lazily fetch the TTS transcript for a turn (stage-2 narration model), cache on the turn.
async function ensureNarration(idx) {
  const t = S.turns[idx];
  if (t.narration) return t.narration;
  const res = await api("/api/narrate", "POST", { text: t.canonical });
  t.narration = res.narration;
  return t.narration;
}

function setBtnLoading(btn, on) {
  if (!btn) return;
  if (on) { btn._t = btn.textContent; btn.textContent = "Preparing…"; btn.disabled = true; }
  else { btn.textContent = btn._t || "▶︎ Listen"; btn.disabled = false; }
}

function renderChunks(cont, narration) {
  const chunks = TTS.chunk(narration);
  cont.innerHTML = chunks.map((c, i) => '<span class="chunk" data-i="' + i + '">' + escapeHtml(c) + " </span>").join("");
}
function highlightChunk(idx, i) {
  const c = document.getElementById("tr-" + idx); if (!c) return;
  c.querySelectorAll(".chunk.active").forEach((s) => s.classList.remove("active"));
  const s = c.querySelector('.chunk[data-i="' + i + '"]');
  if (s) { s.classList.add("active"); s.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
}
function clearHighlight(idx) {
  const c = document.getElementById("tr-" + idx);
  if (c) c.querySelectorAll(".chunk.active").forEach((s) => s.classList.remove("active"));
}

async function listen(idx, btn) {
  if (S.speechProvider === "openai") return listenOpenAI(idx, btn);
  // Browser (Web Speech) path: chunked playback with sentence read-along highlight.
  if (btn && btn.classList.contains("playing")) { TTS.stop(); return; }
  TTS.stop();
  setBtnLoading(btn, true);
  let narration;
  try { narration = await ensureNarration(idx); }
  catch (e) { toast(e.message); setBtnLoading(btn, false); return; }
  setBtnLoading(btn, false);
  const cont = document.getElementById("tr-" + idx);
  renderChunks(cont, narration); cont.classList.remove("hidden");
  const tbtn = document.querySelector('.transcript-toggle[data-idx="' + idx + '"]');
  if (tbtn) tbtn.textContent = "Hide transcript";
  TTS.speak(narration, btn, { onChunk: (i) => highlightChunk(idx, i), onDone: () => clearHighlight(idx) });
}

// OpenAI: narrate + synthesize as a server-side background job we POLL (see app/audio_jobs.py)
// rather than one blocking request a tunnel/proxy timeout can 524 mid-synthesis; the button
// shows the live stage and real segment progress. Result plays in a native <audio> element
// (robust; play/pause/resume/seek; downloadable). No mid-stream cut-outs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function audioStageLabel(job) {
  if (job.stage === "narrating") return "Adapting for listening…";
  if (job.segments_total > 1)
    return "Synthesizing " + Math.min(job.segments_done + 1, job.segments_total) + "/" + job.segments_total + "…";
  return "Synthesizing…";
}

async function listenOpenAI(idx, btn) {
  const turnEl = btn.closest(".turn");
  if (turnEl.querySelector("audio.tts-audio")) return;  // player already present
  setBtnLoading(btn, true);
  let narration, url;
  try {
    let job = (await api("/api/audio/jobs", "POST", { text: S.turns[idx].canonical })).job;
    let blips = 0;
    while (job.status === "running") {
      if (btn) btn.textContent = audioStageLabel(job);
      await sleep(1000);
      try { job = (await api("/api/audio/jobs/" + job.id)).job; blips = 0; }
      catch (e) {
        // Tolerate brief network drops — the job keeps running server-side regardless.
        if (++blips >= 8) throw e;
      }
    }
    if (job.status !== "done" || !job.url) throw new Error(job.error || "Could not prepare audio.");
    narration = job.narration;
    url = job.url;
    S.turns[idx].narration = narration;
  } catch (e) { toast(e.message); setBtnLoading(btn, false); return; }
  const cont = document.getElementById("tr-" + idx);
  cont.textContent = narration; cont.classList.remove("hidden");
  const row = btn.closest(".audio-row");
  row.innerHTML =
    '<audio class="tts-audio" controls preload="auto" src="' + withTok(url) + '"></audio>' +
    '<a class="dl" href="' + withTok(url) + '" download="' + S.slug + '-narration.mp3">⬇ mp3</a>' +
    '<button class="transcript-toggle" data-idx="' + idx + '">Hide transcript</button>';
  row.querySelector(".transcript-toggle").onclick = (e) => toggleTranscript(idx, e.currentTarget);
  row.querySelector("audio.tts-audio").play().catch(() => {});  // best-effort; controls remain
}

async function toggleTranscript(idx, btn) {
  const cont = document.getElementById("tr-" + idx);
  if (!cont.classList.contains("hidden")) { cont.classList.add("hidden"); btn.textContent = "Transcript"; return; }
  btn.textContent = "Loading…";
  let narration;
  try { narration = await ensureNarration(idx); }
  catch (e) { toast(e.message); btn.textContent = "Transcript"; return; }
  renderChunks(cont, narration); cont.classList.remove("hidden"); btn.textContent = "Hide transcript";
}

function renderDiscussion(p, transcript, readonly) {
  S.view = "discussion";
  // Always regenerate narration via the stage-2 model; ignore any stored on the turn.
  S.turns = transcript.map((t) => Object.assign({}, t, { narration: "" }));
  let body = S.turns.map((t, i) => turnHtml(t, i)).join("");
  if (!body) body = '<p class="muted">No turns yet.</p>';
  $app.innerHTML = body;
  wireAudio($app);

  // If the last turn is a reply that never got a response (a prior turn errored), offer to retry.
  const last = S.turns[S.turns.length - 1];
  if (last && last.role === "user") showGenNote();

  const doneLabel = S.slug === REVIEW_SLUG ? "✓ Update working notes" : "✓ We're done — draft notes";
  const composer = document.createElement("div");
  composer.className = "composer";
  composer.innerHTML =
    '<div class="tools"><select id="favModel" class="favsel" title="Analysis model"></select>' +
    (readonly ? '<span class="muted">committed (read)</span>' : "") + "</div>" +
    '<div class="inrow"><textarea id="reply" rows="1" placeholder="Type your reply…"></textarea>' +
    '<button class="send" id="sendBtn">Send</button></div>' +
    '<div class="btn-row"><button class="ghost" id="doneBtn">' + doneLabel + "</button></div>";
  document.body.appendChild(composer);
  S._composer = composer;

  const ta = composer.querySelector("#reply");
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; };
  composer.querySelector("#sendBtn").onclick = () => sendReply();
  composer.querySelector("#doneBtn").onclick = () => finishPaper();
  loadFavorites();
  ta.onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendReply(); };
  window.scrollTo(0, document.body.scrollHeight);
}

function removeComposer() { if (S._composer) { S._composer.remove(); S._composer = null; } }

// Turn an OpenRouter slug into a readable name+version, e.g.
// "anthropic/claude-opus-4.8" -> "Claude Opus 4.8", "deepseek/deepseek-v4-pro" -> "DeepSeek V4 Pro".
const MODEL_FIXUPS = { gpt: "GPT", glm: "GLM", llm: "LLM", ai: "AI", deepseek: "DeepSeek",
  oss: "OSS", moe: "MoE", hd: "HD", qwen: "Qwen", grok: "Grok", r1: "R1" };
function prettyModel(id) {
  if (!id) return "model…";
  const s = (id.includes("/") ? id.split("/").slice(1).join("/") : id).replace(/[-_]/g, " ");
  return s.split(" ").map((w) => {
    const lw = w.toLowerCase();
    if (MODEL_FIXUPS[lw]) return MODEL_FIXUPS[lw];
    if (/^v\d/.test(lw)) return "V" + w.slice(1);   // v4 -> V4
    if (/^k\d/.test(lw)) return "K" + w.slice(1);   // k2.6 -> K2.6
    if (/\d/.test(w)) return w;                       // version tokens stay (5.5, 4.8)
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}

// Favorites (latest models per family), resolved once from OpenRouter and cached.
async function getFavs() {
  if (!window._favs) { try { window._favs = (await api("/api/favorite_models")).models; } catch (e) { window._favs = []; } }
  return window._favs;
}
function fillModelSelect(sel, favs, selected) {
  if (!sel) return;
  let opts = (favs || []).map((f) => '<option value="' + f.id + '"' + (f.id === selected ? " selected" : "") +
    ">" + escapeHtml(prettyModel(f.id)) + "</option>").join("");
  if (!(favs || []).some((f) => f.id === selected)) {  // keep the current model visible if off-list
    opts = '<option value="' + escapeHtml(selected || "") + '" selected>' + escapeHtml(prettyModel(selected)) + "</option>" + opts;
  }
  sel.innerHTML = opts;
}
// Quick analysis-model switcher in the composer, present in every chat.
async function loadFavorites() {
  const sel = document.getElementById("favModel"); if (!sel) return;
  fillModelSelect(sel, await getFavs(), S.model);
  sel.onchange = async (e) => {
    try { const r = await api("/api/settings", "POST", { model: e.target.value }); S.model = r.model; toast("Model → " + prettyModel(r.model)); }
    catch (err) { toast(err.message); }
  };
}

function appendTurn(t) {
  const idx = S.turns.length;
  S.turns.push(t);
  const div = document.createElement("div");
  div.innerHTML = turnHtml(t, idx);
  $app.appendChild(div.firstChild);
  wireAudio($app);
  window.scrollTo(0, document.body.scrollHeight);
  if (S.autoplay && t.role === "assistant") {
    listen(idx, document.querySelector('.listen[data-idx="' + idx + '"]'));
  }
}

function busyComposer(on) {
  if (!S._composer) return;
  const send = S._composer.querySelector("#sendBtn");
  if (send) send.disabled = on;
}

// Streamed assistant turn: shows a real chat bubble that fills in live, then finalizes.
async function streamTurn(endpoint, body) {
  busyComposer(true);
  const wrap = document.createElement("div");
  wrap.className = "turn"; wrap.id = "streamTurn";
  wrap.innerHTML = '<div class="who">Companion</div><div class="bubble assistant">' +
    '<div class="stream-body"><span class="loading-row"><span class="spinner"></span> Thinking…</span></div></div>';
  $app.appendChild(wrap);
  window.scrollTo(0, document.body.scrollHeight);
  const bodyEl = wrap.querySelector(".stream-body");

  let canon = "", raf = null;
  const draw = () => { raf = null; bodyEl.innerHTML = mdToHtml(canon); };

  let resp;
  try {
    resp = await fetch(endpoint, { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) });
  } catch (e) { wrap.remove(); busyComposer(false); toast("Network error."); showGenNote(); return null; }
  if (!resp.ok || !resp.body) {
    let detail = "HTTP " + resp.status;
    try { detail = (await resp.json()).detail || detail; } catch (e) {}
    wrap.remove(); busyComposer(false); toast(detail); showGenNote(); return null;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "", finalTurn = null, errored = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const rawLine = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const m = rawLine.match(/^data: ?([\s\S]*)$/); if (!m) continue;
      let ev; try { ev = JSON.parse(m[1]); } catch (e) { continue; }
      if (ev.type === "delta") {
        const stick = (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 160;
        canon += ev.text; if (!raf) raf = requestAnimationFrame(draw);
        if (stick) window.scrollTo(0, document.body.scrollHeight);
      } else if (ev.type === "done") { finalTurn = ev.turn; }
      else if (ev.type === "error") { errored = ev.detail; }
    }
  }
  if (raf) cancelAnimationFrame(raf);
  busyComposer(false);
  wrap.remove();
  if (errored) { toast(errored); showGenNote(); return null; }
  if (!finalTurn) { toast("Stream ended unexpectedly."); showGenNote(); return null; }
  appendTurn(finalTurn);
  return finalTurn;
}

function showGenNote() {
  if (document.getElementById("genNote")) return;
  const last = S.turns[S.turns.length - 1];
  if (!last || last.role !== "user") return;
  const note = document.createElement("div");
  note.className = "loading-row"; note.id = "genNote";
  note.innerHTML = '<span class="muted">This reply didn’t get a response.</span> ' +
    '<button class="ghost" id="genBtn">↻ Generate response</button>';
  $app.appendChild(note);
  note.querySelector("#genBtn").onclick = () => continueTurn();
}

async function sendReply() {
  const ta = S._composer.querySelector("#reply");
  const text = ta.value.trim(); if (!text) return;
  appendTurn({ role: "user", text });
  ta.value = ""; ta.style.height = "auto";
  const turn = await streamTurn(pp("/reply_stream"), { slug: S.slug, text });
  if (turn && turn.proposed_commit) openPaper(S.slug);
}

async function continueTurn() {
  const note = document.getElementById("genNote"); if (note) note.remove();
  const turn = await streamTurn(pp("/continue_stream"), { slug: S.slug });
  if (turn && turn.proposed_commit) openPaper(S.slug);
}

// Regenerate an assistant turn with a chosen model. For an earlier turn this discards what
// came after it. (The first turn is handled separately via the compose-first screen.)
async function retryWithModel(idx, modelId) {
  const aidx = S.turns.slice(0, idx + 1).filter((t) => t.role === "assistant").length - 1;
  if (aidx < 0) return;
  if (idx !== S.turns.length - 1 && !confirm("Retry this response? The messages after it will be discarded.")) return;
  stopAllAudio();
  const note = document.getElementById("genNote"); if (note) note.remove();
  $app.querySelectorAll(".turn").forEach((el, i) => { if (i >= idx) el.remove(); });
  S.turns = S.turns.slice(0, idx);
  if (modelId) S.model = modelId;
  const turn = await streamTurn(pp("/retry_stream"), { slug: S.slug, assistant_index: aidx, model: modelId || null });
  const fs = document.getElementById("favModel"); if (fs) fillModelSelect(fs, window._favs || [], S.model);
  if (turn && turn.proposed_commit) openPaper(S.slug);
}

// The ⋯ menu under each response: retry-with-model for any turn; the first turn routes to the
// compose-first screen so the opening prompt and model can both be edited.
async function openTurnMenu(idx, btn) {
  closeTurnMenu();
  const aidx = S.turns.slice(0, idx + 1).filter((t) => t.role === "assistant").length - 1;
  const menu = document.createElement("div"); menu.className = "menu"; menu.id = "turnMenu";
  if (aidx <= 0) {
    menu.innerHTML = '<div class="menu-h">Retry first response</div>' +
      '<button class="menu-i" data-act="compose">✎ Edit prompt &amp; pick model…</button>';
  } else {
    const favs = await getFavs();
    const items = [];
    if (!favs.some((f) => f.id === S.model)) items.push({ id: S.model, label: prettyModel(S.model) + " · current" });
    favs.forEach((f) => items.push({ id: f.id, label: prettyModel(f.id) }));
    menu.innerHTML = '<div class="menu-h">Retry with…</div>' +
      items.map((it) => '<button class="menu-i" data-model="' + escapeHtml(it.id) + '">' + escapeHtml(it.label) + "</button>").join("");
  }
  btn.parentNode.appendChild(menu);
  menu.querySelectorAll(".menu-i").forEach((b) => b.onclick = (e) => {
    e.stopPropagation(); closeTurnMenu();
    if (b.dataset.act === "compose") openComposeFirst(S.slug);
    else retryWithModel(idx, b.dataset.model);
  });
  setTimeout(() => document.addEventListener("click", closeTurnMenu, { once: true }), 0);
}
function closeTurnMenu() { const m = document.getElementById("turnMenu"); if (m) m.remove(); }

async function finishPaper() {
  if (!confirm("Wrap up this paper? The agent will draft the Notes block and a synthesis update for your review.")) return;
  const turn = await streamTurn(pp("/finish_stream"), { slug: S.slug });
  if (turn && turn.proposed_commit) { removeComposer(); renderReview(S.slug); }
  else if (turn) toast("Agent kept discussing instead of drafting — nudge it or try again.");
}

async function renderReview(slug) {
  removeComposer(); stopAllAudio(); S.view = "review";
  $app.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading draft…</div>';
  let r;
  try { r = await api(pp("/review/" + slug)); } catch (e) { toast(e.message); return; }
  const isReview = slug === REVIEW_SLUG;
  setTitle(isReview ? "Update working notes" : "Review — " + r.title, true);
  let html = '<div class="panel"><h3>' + (isReview ? "Update working notes" : "Approve notes &amp; working notes") + "</h3>" +
    '<p class="muted">' + escapeHtml(r.summary || "") + "</p>";
  if (!isReview) {
    html += '<div class="review-sec"><div class="muted">Notes block → appended to corpus/' + slug + ".md</div>" +
      '<textarea id="notes">' + escapeHtml(r.notes_block || "") + "</textarea></div>";
  }
  html += '<div class="review-sec"><div class="muted">Working notes (rewritten whole)</div>' +
    '<textarea id="synth">' + escapeHtml(r.synthesis_proposed || "") + "</textarea></div>" +
    '<details><summary>Current working notes (before)</summary><pre>' + escapeHtml(r.synthesis_current || "") + "</pre></details>" +
    '<div class="btn-row"><button class="primary" id="approveBtn">✓ Approve &amp; commit</button>' +
    '<button class="ghost" id="changesBtn">Request changes</button>' +
    '<button class="ghost" id="backDisc">Back to discussion</button></div>' +
    '<div id="reviewMsg"></div></div>';
  $app.innerHTML = html;
  document.getElementById("approveBtn").onclick = () => approve(slug);
  document.getElementById("changesBtn").onclick = () => requestChanges(slug);
  document.getElementById("backDisc").onclick = () => backToDiscussion(slug);
}

async function backToDiscussion(slug) {
  try { await api(pp("/reopen"), "POST", { slug }); }
  catch (e) { toast(e.message); return; }
  openPaper(slug);  // state is now in_discussion -> renders the discussion + composer
}

async function approve(slug) {
  const notesEl = document.getElementById("notes");           // absent in the working-notes review
  const body = { slug, synthesis: document.getElementById("synth").value };
  if (notesEl) body.notes_block = notesEl.value;
  const btn = document.getElementById("approveBtn"); btn.disabled = true; btn.textContent = "Committing…";
  try { const res = await api(pp("/approve"), "POST", body);
    toast("Committed " + res.result.rev + (slug === REVIEW_SLUG ? " — working notes updated." : " — marked read."));
    loadLibrary(); }
  catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "✓ Approve & commit"; }
}

async function requestChanges(slug) {
  const text = prompt("What should change in the notes / synthesis?");
  if (!text) return;
  // Streamed like every other turn: a blocking POST sends no bytes until the revision is
  // done, and the tunnel kills responseless requests at ~100s (524).
  const turn = await streamTurn(pp("/request_changes_stream"), { slug, text });
  if (!turn) return;
  if (turn.proposed_commit) renderReview(slug); else openPaper(slug);
}

/* ---------------- settings ---------------- */
const $settings = document.getElementById("settings");
async function openSettings() {
  $settings.classList.remove("hidden");
  try { const s = await api("/api/settings");
    document.getElementById("keyHint").textContent = s.has_key ? ("key set: " + s.key_hint) : "no key set";
    if (s.model) S.model = s.model;
    if (s.narration_model) S.narrationModel = s.narration_model;
    document.getElementById("openaiHint").textContent = s.has_openai_key ? ("key set: " + s.openai_key_hint) : "no key set";
    const sp = document.getElementById("speechProvider"); sp.value = s.speech_provider || "openai"; S.speechProvider = sp.value;
    document.getElementById("ttsVoice").innerHTML = (s.voices || []).map((v) =>
      '<option value="' + v + '"' + (v === s.tts_voice ? " selected" : "") + ">" + v + "</option>").join("");
    if (s.tts_model) document.getElementById("ttsModel").value = s.tts_model;
    toggleOpenaiFields();
  } catch (e) { /* ignore */ }
  // voices
  const vsel = document.getElementById("voiceSelect");
  const fill = () => {
    const vs = TTS.loadVoices();
    vsel.innerHTML = '<option value="">(auto)</option>' + vs.map((v) =>
      '<option value="' + v.voiceURI + '"' + (v.voiceURI === TTS.voiceURI ? " selected" : "") + ">" +
      escapeHtml(v.name + " — " + v.lang) + "</option>").join("");
  };
  fill(); if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { TTS.loadVoices(); fill(); };
  document.getElementById("rate").value = TTS.rate;
  document.getElementById("autoplayReply").checked = S.autoplay;
  loadModels();
}
async function loadModels() {
  const m = document.getElementById("modelSelect"), n = document.getElementById("narrSelect");
  m.innerHTML = n.innerHTML = "<option>loading…</option>";
  try {
    const r = await api("/api/models"); window._models = r.models;
    renderModelsInto(m, "", S.model); renderModelsInto(n, "", S.narrationModel);
  } catch (e) {
    m.innerHTML = '<option value="' + (S.model || "") + '">' + (S.model || "(could not load list)") + "</option>";
    n.innerHTML = '<option value="' + (S.narrationModel || "") + '">' + (S.narrationModel || "(could not load list)") + "</option>";
  }
}
function renderModelsInto(sel, filter, selected) {
  const f = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (window._models || []).filter((m) => f.every((w) => (m.id + " " + m.name).toLowerCase().includes(w)));
  sel.innerHTML = list.slice(0, 400).map((m) =>
    '<option value="' + m.id + '"' + (m.id === selected ? " selected" : "") + ">" + escapeHtml(m.id) + "</option>").join("");
}
function toggleOpenaiFields() {
  const on = document.getElementById("speechProvider").value === "openai";
  document.getElementById("openaiFields").style.display = on ? "" : "none";
  document.getElementById("browserVoiceRow").style.display = on ? "none" : "";
}
function closeSettings() { $settings.classList.add("hidden"); }
async function saveSettings() {
  const key = document.getElementById("apiKey").value.trim();
  const model = document.getElementById("modelSelect").value || S.model;
  const narration_model = document.getElementById("narrSelect").value || S.narrationModel;
  const speech_provider = document.getElementById("speechProvider").value;
  const tts_voice = document.getElementById("ttsVoice").value;
  const tts_model = document.getElementById("ttsModel").value;
  const okey = document.getElementById("openaiKey").value.trim();
  TTS.voiceURI = document.getElementById("voiceSelect").value; localStorage.setItem("rc_voice", TTS.voiceURI);
  TTS.rate = parseFloat(document.getElementById("rate").value); localStorage.setItem("rc_rate", TTS.rate);
  S.autoplay = document.getElementById("autoplayReply").checked; localStorage.setItem("rc_autoplay", S.autoplay ? "1" : "0");
  const patch = { model, narration_model, speech_provider, tts_voice, tts_model };
  if (key) patch.openrouter_api_key = key;
  if (okey) patch.openai_api_key = okey;
  try { const res = await api("/api/settings", "POST", patch);
    S.model = res.model; S.narrationModel = res.narration_model; S.hasKey = res.has_key;
    S.speechProvider = res.speech_provider;
    toast("Saved."); closeSettings(); if (S.view === "library") loadLibrary(); }
  catch (e) { toast(e.message); }
}

/* ---------------- workflow prompt editor ---------------- */
async function renderPrompts() {
  stopAllAudio(); removeComposer(); S.view = "prompts";
  setTitle("Workflow prompts", true);
  $app.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading prompts…</div>';
  let data;
  try { data = await api("/api/prompts"); } catch (e) { toast(e.message); return; }
  let html = '<p class="muted">Prompt files configured on the server are read-only here; edit them in Obsidian. Legacy prompts remain editable when no prompt directory is configured.</p>';
  data.prompts.forEach((p) => {
    const ph = (p.placeholders && p.placeholders.length)
      ? " · placeholders: " + p.placeholders.map((x) => "{" + x + "}").join(" ") : "";
    const src = p.path ? " · " + (p.valid ? "valid" : "INVALID") + " · " + p.path
      : " · source: " + p.source;
    const error = p.error ? '<p class="error">' + escapeHtml(p.error) + "</p>" : "";
    const controls = p.managed ? "" :
      '<div class="btn-row"><button class="primary save-prompt">Save</button>' +
      (p.storage === "file" ? "" : '<button class="ghost reset-prompt">Reset to default</button>') +
      "</div>";
    html += '<div class="panel prompt-card" data-key="' + p.key + '">' +
      "<h3>" + escapeHtml(p.label) + (p.is_overridden ? ' <span class="badge in_discussion">edited</span>' : "") + "</h3>" +
      '<p class="muted">' + escapeHtml(p.description) + escapeHtml(ph + src) + "</p>" +
      error + '<textarea class="prompt-text"' + (p.managed ? " readonly" : "") + ">" +
      escapeHtml(p.value) + "</textarea>" + controls + "</div>";
  });
  $app.innerHTML = html;
  $app.querySelectorAll(".prompt-card").forEach((card) => {
    const key = card.dataset.key;
    const ta = card.querySelector(".prompt-text");
    const sb = card.querySelector(".save-prompt");
    if (sb) sb.onclick = () => savePrompt(key, ta, card);
    const rb = card.querySelector(".reset-prompt");
    if (rb) rb.onclick = () => resetPrompt(key, ta, card);
  });
}

function markEdited(card, on) {
  const h3 = card.querySelector("h3");
  let b = h3.querySelector(".badge");
  if (on && !b) { const s = document.createElement("span"); s.className = "badge in_discussion"; s.textContent = "edited"; s.style.marginLeft = "8px"; h3.appendChild(s); }
  if (!on && b) b.remove();
}

async function savePrompt(key, ta, card) {
  const btn = card.querySelector(".save-prompt"); const old = btn.textContent;
  btn.disabled = true; btn.textContent = "Saving…";
  try { const res = await api("/api/prompts", "POST", { key, value: ta.value });
    ta.value = res.value; markEdited(card, res.is_overridden); toast("Saved.");
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}

async function resetPrompt(key, ta, card) {
  if (!confirm("Reset this prompt to the built-in default?")) return;
  try { const res = await api("/api/prompts/reset", "POST", { key });
    ta.value = res.value; markEdited(card, res.is_overridden); toast("Reset to default.");
  } catch (e) { toast(e.message); }
}

/* ---------------- wire up ---------------- */
document.getElementById("settingsBtn").onclick = openSettings;
document.getElementById("closeSettings").onclick = closeSettings;
document.getElementById("saveSettings").onclick = saveSettings;
document.getElementById("modelSearch").oninput = (e) =>
  renderModelsInto(document.getElementById("modelSelect"), e.target.value, document.getElementById("modelSelect").value || S.model);
document.getElementById("narrSearch").oninput = (e) =>
  renderModelsInto(document.getElementById("narrSelect"), e.target.value, document.getElementById("narrSelect").value || S.narrationModel);
document.getElementById("speechProvider").onchange = toggleOpenaiFields;
document.getElementById("editPrompts").onclick = () => { closeSettings(); renderPrompts(); };
$back.onclick = () => { removeComposer(); loadLibrary(); };
$settings.onclick = (e) => { if (e.target === $settings) closeSettings(); };

S.autoplay = localStorage.getItem("rc_autoplay") === "1";
TTS.loadVoices();

async function boot() {
  await initAuth();
  const so = document.getElementById("signOutRow");
  if (so) so.classList.toggle("hidden", !(Auth.mode === "supabase" && Auth.accessToken));
  if (needLogin()) return renderLogin();
  loadLibrary();
}
const signOutBtn = document.getElementById("signOutBtn");
if (signOutBtn) signOutBtn.onclick = signOut;
boot();
