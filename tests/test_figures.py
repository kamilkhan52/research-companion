"""R.10 phase 1 — arXiv-HTML figure manifests: deterministic parse, identity-keyed cache,
SSRF posture on image URLs, and the never-fails enrichment pass. Network functions are
injected fakes (the conftest stubs the real ones); the suite stays network-free."""
from __future__ import annotations

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
    def fetch(base_id):
        fetch.calls.append(base_id)
        if status is not None:
            return status, None, None
        return ("none", None, None) if html is None else ("ok", final, html)
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
    assert len(html.calls) == 2
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
    <figure id="F2"><img src="x2.svg"><figcaption>Figure 2: svg.</figcaption></figure>
    <figure id="F3"><img src="data:image/png;base64,AAAA">
    <figcaption>Figure 3: data uri.</figcaption></figure>
    <figure id="F4"><img src="x4.png"><figcaption>Figure 4: fine.</figcaption></figure>"""
    image = fake_image()
    manifest = figures.derive_for_slug(slug, fetch_html=fake_html(html=html),
                                       fetch_image=image)
    assert [f["number"] for f in manifest["figures"]] == [4]
    assert image.calls == ["https://arxiv.org/html/2401.00001v1/x4.png"]


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

    def stalling(base_id):
        raise figures.StallError("read timeout")

    try:
        figures.derive_for_slug(slug, fetch_html=stalling, fetch_image=fake_image())
    except figures.StallError:
        pass
    assert figures.read_manifest(slug) is None
