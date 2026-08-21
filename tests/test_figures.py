"""R.10 phase 1 — arXiv-HTML figure manifests: deterministic parse, identity-keyed cache,
SSRF posture on image URLs, and the never-fails enrichment pass. Network functions are
injected fakes (the conftest stubs the real ones); the suite stays network-free."""
from __future__ import annotations

import json

from app import figures, store

from tests.conftest import add_paper

FINAL_URL = "https://arxiv.org/html/2401.00001v1"

HTML = """<html><body>
<figure id="S2.F1" class="ltx_figure">
  <img src="/html/2401.00001v1/x1.png" class="ltx_graphics" alt="Overview" width="620" height="410">
  <figcaption class="ltx_caption"><span class="ltx_tag">Figure 1: </span>The system
  overview.</figcaption>
</figure>
<figure id="S3.F2" class="ltx_figure">
  <figure id="S3.F2.sf1" class="ltx_figure ltx_figure_panel">
    <img src="x2.png" alt="left panel">
    <figcaption class="ltx_caption">(a) left</figcaption>
  </figure>
  <figcaption class="ltx_caption">Figure 2: Two panels compared.</figcaption>
</figure>
<figure id="S4.T1" class="ltx_table">
  <figcaption>Table 1: no image inside, dropped.</figcaption>
</figure>
</body></html>"""


def fake_html(html=HTML, final=FINAL_URL, status=None):
    def fetch(base_id, skip=frozenset()):
        fetch.calls.append(base_id)
        if status is not None:
            return status, None, None
        if html is None or final in skip:
            return "none", None, None
        return "ok", final, html
    fetch.calls = []
    return fetch


def fake_image(payload=b"png-bytes"):
    def fetch(url):
        fetch.calls.append(url)
        return payload, ".png"
    fetch.calls = []
    return fetch


def paper(slug="deepstack", title="DeepStack", arxiv_id="2401.00001v2"):
    add_paper("test-project", slug, title)
    if arxiv_id:
        store.annotate_entry(slug, arxiv_id=arxiv_id, authoritative=True)
        # Retrieval also stamps the corpus meta with the exact id it fetched — the
        # version-bearing identity figures key on (corpus-first).
        store.write_full_text(slug, title, "full text", {"slug": slug, "arxiv_id": arxiv_id})
    return slug


# --- parsing ---------------------------------------------------------------------------------

def test_parse_collects_top_level_figures_with_outer_captions():
    figs = figures.parse_figures(HTML)
    assert [f["id"] for f in figs] == ["S2.F1", "S3.F2"]  # table without img dropped
    assert figs[0]["caption"] == "Figure 1: The system overview."
    assert figs[0]["width"] == 620 and figs[0]["height"] == 410
    # The nested panel contributes its image to the parent; the parent keeps ITS caption.
    assert figs[1]["src"] == "x2.png"
    assert figs[1]["caption"] == "Figure 2: Two panels compared."
    assert figures._figure_number(figs[0]) == 1
    assert figures._figure_number(figs[1]) == 2


def test_figure_number_falls_back_to_the_element_id():
    assert figures._figure_number({"caption": "no marker", "id": "S9.F14"}) == 14
    assert figures._figure_number({"caption": "", "id": "S4.T2"}) is None


def test_html_fetch_falls_back_when_native_page_has_no_image_figures(monkeypatch):
    native = "https://arxiv.org/html/2401.00001v1"
    fallback = "https://ar5iv.labs.arxiv.org/html/2401.00001v1"
    calls = []

    class Response:
        status_code = 200
        headers = {"content-type": "text/html"}

        def __init__(self, text):
            self.text = text

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def get(self, url):
            calls.append(url)
            return Response("<html>abstract only</html>" if url == native else HTML)

    monkeypatch.setattr(figures, "_open_client", Client)
    monkeypatch.setattr(figures, "_resolves_public", lambda url: True)
    status, final_url, html = figures._fetch_html_impl("2401.00001v1")
    assert calls == [native, fallback]
    assert (status, final_url, html) == ("ok", fallback, HTML)


def test_html_fetch_falls_back_when_native_figures_are_all_unfetchable(monkeypatch):
    """A native page whose figures would ALL be dropped by derivation (data:-URI-only here;
    SVG stopped being a drop with DR-091) must not shadow ar5iv: accepting it caches a
    'done' manifest with zero entries for good."""
    native = "https://arxiv.org/html/2401.00001v1"
    fallback = "https://ar5iv.labs.arxiv.org/html/2401.00001v1"
    svg_only = """<figure id="S1.F1">
      <img src="data:image/png;base64,AAAA">
      <figcaption>Figure 1: Inline-data-only diagram.</figcaption>
    </figure>"""
    calls = []

    class Response:
        status_code = 200
        headers = {"content-type": "text/html"}

        def __init__(self, text):
            self.text = text

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def get(self, url):
            calls.append(url)
            return Response(svg_only if url == native else HTML)

    monkeypatch.setattr(figures, "_open_client", Client)
    monkeypatch.setattr(figures, "_resolves_public", lambda url: True)
    status, final_url, html = figures._fetch_html_impl("2401.00001v1")
    assert calls == [native, fallback]
    assert (status, final_url, html) == ("ok", fallback, HTML)


# --- derivation + cache ----------------------------------------------------------------------

def test_derive_writes_manifest_and_assets(temp_project):
    slug = paper()
    html, image = fake_html(), fake_image()
    manifest = figures.derive_for_slug(slug, fetch_html=html, fetch_image=image)
    assert manifest["status"] == "done"
    assert manifest["arxiv_id"] == "2401.00001"  # versionless
    assert manifest["source"] == FINAL_URL
    numbers = [f["number"] for f in manifest["figures"]]
    assert numbers == [1, 2]
    # Relative srcs resolve against the final page URL.
    assert manifest["figures"][0]["src"] == "https://arxiv.org/html/2401.00001v1/x1.png"
    assert manifest["figures"][1]["src"] == "https://arxiv.org/html/2401.00001v1/x2.png"
    for fig in manifest["figures"]:
        path = figures.asset_path(slug, fig["asset"])
        assert path is not None and path.read_bytes() == b"png-bytes"
    # Cached: a second derive is served from the manifest, no refetch.
    again = figures.derive_for_slug(slug, fetch_html=html, fetch_image=image)
    assert again["fetched_ts"] == manifest["fetched_ts"]
    assert len(html.calls) == 1


def test_all_image_downloads_failing_tries_next_source_never_empty_done(temp_project):
    """Every listed image failing at download time (dead links, bad types, oversized) must
    not cache a 'done' manifest with zero entries — the next renderer is tried, and full
    exhaustion is a cool-down 'none' miss (sol review round 2, PR #201)."""
    slug = paper()
    html = fake_html()

    def no_image(url):
        no_image.calls.append(url)
        return None
    no_image.calls = []

    manifest = figures.derive_for_slug(slug, fetch_html=html, fetch_image=no_image)
    assert manifest["status"] == "none"
    assert manifest["figures"] == []
    assert len(html.calls) == 2  # the first page was exhausted, the fallback then skipped it
    assert no_image.calls  # downloads were genuinely attempted


def test_native_arxiv_id_prefixed_image_path_does_not_duplicate_id(temp_project):
    slug = paper()
    html = """<figure id="S2.F1">
      <img src="2401.00001v1/Figures/model.png">
      <figcaption>Figure 1: Native arXiv path.</figcaption>
    </figure>"""
    image = fake_image()
    manifest = figures.derive_for_slug(
        slug, fetch_html=fake_html(html=html), fetch_image=image
    )
    expected = "https://arxiv.org/html/2401.00001v1/Figures/model.png"
    assert image.calls == [expected]
    assert manifest["figures"][0]["src"] == expected


def test_paper_without_arxiv_identity_keeps_no_manifest(temp_project):
    slug = paper(arxiv_id=None)
    assert figures.derive_for_slug(slug, fetch_html=fake_html(),
                                   fetch_image=fake_image()) is None
    assert figures.read_manifest(slug) is None


def test_failed_html_fetch_caches_none_with_cooldown(temp_project, monkeypatch):
    slug = paper()
    html = fake_html(html=None)
    manifest = figures.derive_for_slug(slug, fetch_html=html, fetch_image=fake_image())
    assert manifest["status"] == "none" and manifest["figures"] == []
    # Within the cool-down the cached miss is served — arXiv isn't re-polled every build.
    figures.derive_for_slug(slug, fetch_html=html, fetch_image=fake_image())
    assert len(html.calls) == 1
    # After the cool-down it retries (papers can gain an HTML rendering later).
    monkeypatch.setattr(figures, "NONE_RETRY_S", 0.0)
    figures.derive_for_slug(slug, fetch_html=html, fetch_image=fake_image())
    assert len(html.calls) == 2


def test_transport_error_caches_nothing(temp_project):
    slug = paper()
    html = fake_html(status="error")
    assert figures.derive_for_slug(slug, fetch_html=html, fetch_image=fake_image()) is None
    assert figures.read_manifest(slug) is None  # NOT a 7-day miss — retried next warm/build
    figures.derive_for_slug(slug, fetch_html=html, fetch_image=fake_image())
    assert len(html.calls) == 2


def test_identity_correction_drops_the_old_papers_figures(temp_project):
    slug = paper()
    figures.derive_for_slug(slug, fetch_html=fake_html(), fetch_image=fake_image())
    old_assets = list(figures.asset_dir(slug).iterdir())
    assert old_assets
    # Retrieval later confirms a DIFFERENT paper under the same slug (a correction always
    # re-persists the corpus, whose meta carries the corrected id).
    store.annotate_entry(slug, arxiv_id="2502.99999", authoritative=True)
    store.write_full_text(slug, "DeepStack", "the other paper's text",
                          {"slug": slug, "arxiv_id": "2502.99999"})
    assert figures.manifest_for(slug) is None  # stale manifest is withheld immediately
    manifest = figures.derive_for_slug(slug, fetch_html=fake_html(), fetch_image=fake_image())
    assert manifest["arxiv_id"] == "2502.99999"
    assert figures.manifest_for(slug)["arxiv_id"] == "2502.99999"


def test_version_advance_rebuilds_the_manifest(temp_project):
    slug = paper(arxiv_id="2401.00001v1")
    html = fake_html()
    figures.derive_for_slug(slug, fetch_html=html, fetch_image=fake_image())
    # A re-retrieval fetches the revised v2 (same versionless base, new figures) — the
    # corpus meta carries the new version even though the entry id never changes.
    store.write_full_text(slug, "DeepStack", "revised text",
                          {"slug": slug, "arxiv_id": "2401.00001v2"})
    manifest = figures.derive_for_slug(slug, fetch_html=html, fetch_image=fake_image())
    # The HTML request carries the version, so the rendering matches the corpus text.
    assert html.calls == ["2401.00001v1", "2401.00001v2"]
    assert manifest["requested_id"] == "2401.00001v2"
    assert figures.manifest_for(slug) is not None  # same base — still serves


def test_stall_mid_download_preserves_the_previous_assets(temp_project):
    slug = paper()
    figures.derive_for_slug(slug, fetch_html=fake_html(), fetch_image=fake_image())
    before = sorted(p.name for p in figures.asset_dir(slug).iterdir())

    def stalling(url):
        raise figures.StallError("read timeout")

    try:
        figures.derive_for_slug(slug, force=True, fetch_html=fake_html(),
                                fetch_image=stalling)
    except figures.StallError:
        pass
    # The old assets and the done manifest that points at them are fully intact.
    assert sorted(p.name for p in figures.asset_dir(slug).iterdir()) == before
    assert figures.manifest_for(slug)["status"] == "done"


def test_unsafe_image_urls_are_dropped(temp_project):
    slug = paper()
    html = """<figure id="F1"><img src="https://evil.com/x.png">
    <figcaption>Figure 1: off allowlist.</figcaption></figure>
    <figure id="F2"><img src="x2.svg"><figcaption>Figure 2: svg, now allowed.</figcaption></figure>
    <figure id="F3"><img src="data:image/png;base64,AAAA">
    <figcaption>Figure 3: data uri.</figcaption></figure>
    <figure id="F4"><img src="x4.png"><figcaption>Figure 4: fine.</figcaption></figure>"""
    image = fake_image()
    manifest = figures.derive_for_slug(slug, fetch_html=fake_html(html=html),
                                       fetch_image=image)
    # DR-091: an .svg path is no longer dropped at URL time — the download path gates
    # it by content-type and the _svg_is_safe reject filter (the fake accepts it here).
    assert [f["number"] for f in manifest["figures"]] == [2, 4]
    assert image.calls == ["https://arxiv.org/html/2401.00001v1/x2.svg",
                           "https://arxiv.org/html/2401.00001v1/x4.png"]


def test_failed_image_download_drops_only_that_figure(temp_project):
    slug = paper()

    def flaky(url):
        return None if "x1" in url else (b"ok", ".png")

    manifest = figures.derive_for_slug(slug, fetch_html=fake_html(), fetch_image=flaky)
    assert [f["number"] for f in manifest["figures"]] == [2]


# --- SSRF guard ------------------------------------------------------------------------------

def test_host_allowlist():
    ok = ["https://arxiv.org/html/x.png", "https://ar5iv.labs.arxiv.org/y.png",
          "https://export.arxiv.org/z.png", "https://ar5iv.org/a.png"]
    bad = ["http://arxiv.org/x.png",             # not https
           "https://evil.com/x.png",
           "https://arxiv.org.evil.com/x.png",   # suffix spoof
           "https://localhost/x.png",
           "data:image/png;base64,AAAA"]
    assert all(figures._host_allowed(u) for u in ok)
    assert not any(figures._host_allowed(u) for u in bad)


def test_asset_path_is_a_trust_boundary(temp_project):
    assert figures.asset_path("slug", "../../secrets.png") is None
    assert figures.asset_path("slug", "a/b.png") is None
    assert figures.asset_path("slug", ".hidden") is None
    assert figures.asset_path("slug", "") is None
    assert figures.asset_path("slug", "01-S2.F1.png") is not None


# --- serving routes --------------------------------------------------------------------------

def test_manifest_route_returns_none_shape_when_absent(temp_project):
    from app.routers.figures_api import get_figure_manifest
    paper()
    resp = get_figure_manifest(temp_project, "deepstack")
    assert resp.status == "none" and resp.figures == []


def test_manifest_and_asset_routes_serve_the_cache(temp_project):
    from app.routers.figures_api import get_figure_asset, get_figure_manifest
    slug = paper()
    figures.derive_for_slug(slug, fetch_html=fake_html(), fetch_image=fake_image())
    resp = get_figure_manifest(temp_project, slug)
    assert resp.status == "done"
    assert [f.number for f in resp.figures] == [1, 2]
    assert resp.fetched_ts is not None
    served = get_figure_asset(temp_project, slug, resp.figures[0].asset)
    assert str(served.path) == str(figures.asset_path(slug, resp.figures[0].asset))


def test_asset_route_rejects_traversal_and_unknowns(temp_project):
    import pytest
    from app.routers.figures_api import get_figure_asset
    from fastapi import HTTPException
    slug = paper()
    figures.derive_for_slug(slug, fetch_html=fake_html(), fetch_image=fake_image())
    for bad_slug, bad_asset in [("..", "01-x.png"), (slug, "../secrets.png"),
                                (slug, ".hidden"), (slug, "not-there.png")]:
        with pytest.raises(HTTPException):
            get_figure_asset(temp_project, bad_slug, bad_asset)


def test_asset_route_refuses_stale_assets_after_identity_correction(temp_project):
    """A leaked/guessed asset URL must not serve the previous paper's figure once the slug's
    identity is corrected — even before the next derivation deletes the old files."""
    import pytest
    from app.routers.figures_api import get_figure_asset
    from fastapi import HTTPException
    slug = paper()
    manifest = figures.derive_for_slug(slug, fetch_html=fake_html(), fetch_image=fake_image())
    asset = manifest["figures"][0]["asset"]
    store.annotate_entry(slug, arxiv_id="2502.99999", authoritative=True)
    store.write_full_text(slug, "DeepStack", "the other paper's text",
                          {"slug": slug, "arxiv_id": "2502.99999"})
    assert figures.asset_path(slug, asset).exists()  # not yet cleaned up
    with pytest.raises(HTTPException):
        get_figure_asset(temp_project, slug, asset)


# --- enrichment pass -------------------------------------------------------------------------

def test_enrichment_pass_never_raises_and_skips_papers_without_identity(temp_project):
    paper("with-id")
    paper("without-id", title="No Id", arxiv_id=None)
    seen = []

    def derive(slug, *, force=False):
        seen.append(slug)
        raise RuntimeError("boom")  # must not escape the pass

    figures.derive_project_figures(store.list_papers(), derive=derive)
    assert seen == ["with-id"]


def test_enrichment_pass_derives_each_identified_paper(temp_project):
    paper("a", title="Paper A", arxiv_id="2401.00001")
    paper("b", title="Paper B", arxiv_id="2401.00002")
    seen = []

    def derive(slug, *, force=False):
        seen.append((slug, force))

    figures.derive_project_figures(store.list_papers(), force=True, derive=derive)
    assert seen == [("a", True), ("b", True)]


def test_timed_out_worker_stays_in_lifecycle_accounting_until_it_exits(temp_project,
                                                                       monkeypatch):
    """An orphaned deadline worker must keep blocking project deletion
    (jobs.any_running_for_project) until its thread actually exits — otherwise a deletion
    racing the orphan's next write would be silently resurrected."""
    import threading
    import time as _time

    from app import jobs
    monkeypatch.setattr(figures, "HARD_DEADLINE_S", 0.05)
    release = threading.Event()

    def blocked(slug, *, force=False):
        release.wait(5)

    try:
        timed_out = figures._derive_with_deadline("stuck-paper", False, blocked)
        assert timed_out
        assert jobs.any_running_for_project(temp_project) == "figure-orphan"
    finally:
        release.set()
    deadline = _time.time() + 5
    while jobs.any_running_for_project(temp_project) and _time.time() < deadline:
        _time.sleep(0.01)
    assert jobs.any_running_for_project(temp_project) is None


def test_a_refused_orphan_is_joined_rather_than_abandoned(temp_project, monkeypatch):
    """The other side of the test above: when orphan admission LOSES the deletion race, the worker
    is invisible to `any_running_for_project`, so nothing else can hold deletion back. Python cannot
    stop the thread and it can still write into the project, so the only safe answer is for the
    parent to join it. `affiliations` was hardened for this and the identical figures path was not —
    a `RuntimeError` escaped and left a live, unaccounted writer behind.
    """
    import threading

    from app import config, jobs

    monkeypatch.setattr(figures, "HARD_DEADLINE_S", 0.05)
    release = threading.Event()
    wrote = []

    def blocked(slug, *, force=False):
        release.wait(5)
        wrote.append(slug)

    # Refuse admission the way a deletion tombstone does.
    def _refuse(*_args, **_kwargs):
        raise RuntimeError("Project is being modified; not accepting new jobs.")

    monkeypatch.setattr(figures._orphan_registry, "put", _refuse)

    finished = threading.Event()
    outcome: dict = {}

    def _call():
        # However this call ends — returning or raising — record whether the work had already
        # finished. That is the property: the parent must not hand control back to the graph job
        # while a writer it can no longer account for is still running.
        try:
            figures._derive_with_deadline("stuck-paper", False, blocked)
        except Exception as e:  # noqa: BLE001 — the escaping RuntimeError is one of the failures
            outcome["raised"] = repr(e)
        outcome["work_done_on_return"] = list(wrote)
        finished.set()

    token = config.set_active_project(temp_project)
    try:
        caller = threading.Thread(target=_call, daemon=True)
        caller.start()
        assert not finished.wait(0.4), (
            f"parent settled while its worker was still alive: {outcome}")
        assert jobs.any_running_for_project(temp_project) is None  # admission was refused
        release.set()
        assert finished.wait(5), "parent never settled after the worker finished"
    finally:
        release.set()
        config.reset_active_project(token)
    assert outcome.get("raised") is None, outcome
    assert outcome["work_done_on_return"] == ["stuck-paper"], outcome


def test_a_stalled_host_aborts_the_rest_of_the_pass(temp_project):
    paper("a", title="Paper A", arxiv_id="2401.00001")
    paper("b", title="Paper B", arxiv_id="2401.00002")
    seen = []

    def derive(slug, *, force=False):
        seen.append(slug)
        raise figures.StallError("read timeout")

    figures.derive_project_figures(store.list_papers(), derive=derive)
    assert seen == ["a"]  # the stall on the first paper is not repaid on the second


def test_writes_refuse_a_deleting_project(temp_project):
    """A worker that outlives its job (orphaned deadline worker, settling warm) must never
    write into — and thereby recreate — a project being deleted."""
    from app import config
    slug = paper()
    config.mark_project_deleting(temp_project)
    try:
        result = figures.derive_for_slug(slug, fetch_html=fake_html(),
                                         fetch_image=fake_image())
        assert result is None
        assert figures.read_manifest(slug) is None
    finally:
        config.unmark_project_deleting(temp_project)


def test_stalled_fetch_does_not_cache_a_miss(temp_project):
    slug = paper()

    def stalling(base_id, skip=frozenset()):
        raise figures.StallError("read timeout")

    try:
        figures.derive_for_slug(slug, fetch_html=stalling, fetch_image=fake_image())
    except figures.StallError:
        pass
    assert figures.read_manifest(slug) is None


def test_legacy_empty_done_manifest_is_rederived(temp_project):
    """Older code cached status='done' with zero figures when native image paths were
    misresolved or every download failed; the current pipeline records those as 'none'
    with a cool-down instead. A legacy empty 'done' must be treated as a miss (sol round
    3, PR #201) — otherwise live papers keep showing no figures forever."""
    slug = paper()
    figures.figures_dir().mkdir(parents=True, exist_ok=True)
    figures.manifest_path(slug).write_text(json.dumps({
        "version": 1, "arxiv_id": "2401.00001", "requested_id": "2401.00001v2",
        "source": "https://arxiv.org/html/2401.00001v2", "status": "done",
        "fetched_at": "2026-01-01T00:00:00+00:00", "fetched_ts": 1.0, "figures": [],
    }), encoding="utf-8")

    html = fake_html()
    manifest = figures.derive_for_slug(slug, fetch_html=html, fetch_image=fake_image())
    assert html.calls  # the stale empty cache did not short-circuit derivation
    assert manifest["status"] == "done"
    assert manifest["figures"]

    # A non-empty 'done' for the same requested id still short-circuits.
    html2 = fake_html()
    again = figures.derive_for_slug(slug, fetch_html=html2, fetch_image=fake_image())
    assert html2.calls == []
    assert again["figures"] == manifest["figures"]


# --- SVG <object> figures (DR-091) -----------------------------------------------------------

SVG_HTML = """<html><body>
<figure id="S2.F1" class="ltx_figure">
<object type="image/svg+xml" data="2608.11668v2/kvcache-ssd.svg" width="476" height="244"></object>
<figcaption>Figure 1: KV cache placement.</figcaption>
</figure>
<figure id="S6.F6" class="ltx_figure">
<img src="hbf_throughput.png" alt="bars"/>
<figcaption>Figure 6: Throughput.</figcaption>
</figure>
<figure id="S9.F9" class="ltx_figure">
<object type="application/pdf" data="notes.pdf"></object>
<figcaption>Figure 9: Wrong type, dropped.</figcaption>
</figure>
</body></html>"""


def test_parse_collects_svg_object_figures():
    """DR-091: arXiv's native LaTeXML renders pgfplots figures as <object type=image/svg+xml>
    — measured live, 11 of one paper's 12 figures — which the img-only parse dropped."""
    figs = figures.parse_figures(SVG_HTML)
    assert [f["id"] for f in figs] == ["S2.F1", "S6.F6"]   # non-SVG object still dropped
    assert figs[0]["src"] == "2608.11668v2/kvcache-ssd.svg"
    assert figs[0]["width"] == 476
    assert figs[0]["caption"] == "Figure 1: KV cache placement."


SAFE_SVG = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h5"/><text>ok</text></svg>'


def test_svg_safety_filter_rejects_active_or_outward_content():
    assert figures._svg_is_safe(SAFE_SVG) is True
    bad = [
        b'<svg><script>alert(1)</script></svg>',
        b'<svg onload="x()"></svg>',
        b'<svg><a href="https://evil.example">x</a></svg>',
        b'<svg><image xlink:href="//evil.example/x.png"/></svg>',
        b'<svg><style>@import url(x)</style></svg>',
        b'<svg><foreignObject><body>x</body></foreignObject></svg>',
        b'<svg><style>*{background:url("https://evil.example/x")}</style></svg>',
        b'not xml at all',
        "<svg>\udcff".encode("utf-8", "surrogatepass"),
    ]
    for payload in bad:
        assert figures._svg_is_safe(payload) is False, payload[:40]


def test_derive_stores_sanitized_svg_assets(temp_project):
    slug = paper()

    def image(url):
        return (SAFE_SVG, ".svg") if url.endswith(".svg") else (b"png-bytes", ".png")

    manifest = figures.derive_for_slug(
        slug, fetch_html=fake_html(html=SVG_HTML), fetch_image=image)
    assets = {f["asset"] for f in manifest["figures"]}
    assert any(a.endswith(".svg") for a in assets)
    assert manifest["version"] == figures.MANIFEST_VERSION
    svg_asset = next(a for a in assets if a.endswith(".svg"))
    assert figures.asset_path(slug, svg_asset).read_bytes() == SAFE_SVG


def test_stale_manifest_version_is_a_cache_miss(temp_project):
    """A pre-SVG 'done' manifest isn't wrong, just blind to vector-first papers — it must
    re-derive once instead of pinning one figure forever (the DR-091 report itself)."""
    slug = paper()
    html, image = fake_html(html=SVG_HTML), fake_image()
    manifest = figures.derive_for_slug(slug, fetch_html=html, fetch_image=image)
    assert len(html.calls) == 1

    stale = dict(manifest, version=1)
    figures._write_manifest(slug, stale)
    again = figures.derive_for_slug(slug, fetch_html=html, fetch_image=image)
    assert len(html.calls) == 2                      # re-derived, not reused
    assert again["version"] == figures.MANIFEST_VERSION

    figures.derive_for_slug(slug, fetch_html=html, fetch_image=image)
    assert len(html.calls) == 2                      # current version: reused again


def test_svg_only_native_page_is_now_usable(monkeypatch):
    """DR-091's inverse of the fallback test above: a vector-first native rendering is
    exactly the page this fix exists for, so it must be accepted, not shadowed by ar5iv."""
    native = "https://arxiv.org/html/2401.00001v1"
    svg_only = """<figure id="S1.F1">
      <object type="image/svg+xml" data="2401.00001v1/x1.svg"></object>
      <figcaption>Figure 1: Vector-only diagram.</figcaption>
    </figure>"""
    calls = []

    class Response:
        status_code = 200
        headers = {"content-type": "text/html"}

        def __init__(self, text):
            self.text = text

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def get(self, url):
            calls.append(url)
            return Response(svg_only)

    monkeypatch.setattr(figures, "_open_client", Client)
    monkeypatch.setattr(figures, "_resolves_public", lambda url: True)
    status, final_url, html = figures._fetch_html_impl("2401.00001v1")
    assert calls == [native]
    assert (status, final_url) == ("ok", native)
