"""How `retriever._fetch` chooses between the paced arXiv path and the guarded fetcher.

This exists because the choice used to be `"arxiv.org" in url` — a substring test applied to a
CLIENT-SUPPLIED url (`StartReq.pdf_url`). Appending `#arxiv.org` to any address selected the arXiv
branch, which follows redirects and buffers the whole body with no destination check and no byte
ceiling: the entirety of P0-14, reachable by anyone who could type a fragment.
"""
from __future__ import annotations

import pytest
from app import retriever, safe_fetch


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/#arxiv.org",   # the reported bypass
    "http://169.254.169.254/latest/meta-data/?ref=arxiv.org",
    "http://arxiv.org.attacker.example/x.pdf",              # suffix-confusion domain
    "http://notarxiv.org/x.pdf",
    "http://evil.example/arxiv.org/paper.pdf",              # path segment
])
def test_lookalike_urls_do_not_take_the_arxiv_path(url):
    assert retriever._is_arxiv_host(url) is False


@pytest.mark.parametrize("url", [
    "https://arxiv.org/pdf/2201.11705",
    "https://ARXIV.ORG/pdf/2201.11705",       # host comparison is case-insensitive
    "https://export.arxiv.org/api/query",     # subdomain
])
def test_real_arxiv_urls_take_the_arxiv_path(url):
    assert retriever._is_arxiv_host(url) is True


def test_bypass_url_is_actually_refused_end_to_end(monkeypatch):
    """The routing predicate is the fix, but assert the whole path: the metadata URL must reach the
    guarded fetcher and be refused, not merely 'not be classified as arXiv'."""
    def boom(*a, **k):
        raise AssertionError("client-supplied url reached the unguarded arXiv path")

    monkeypatch.setattr(retriever, "_arxiv_get", boom)
    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo",
                        lambda host, port, *a, **k: [(2, 1, 6, "", ("169.254.169.254", port))])
    with pytest.raises(retriever.RetrievalError, match="Refusing"):
        retriever._fetch("http://169.254.169.254/latest/meta-data/#arxiv.org")


def test_arxiv_path_still_validates_the_destination(monkeypatch):
    """Routing on the hostname stops an attacker steering an arbitrary address into this branch,
    but not DNS games against arxiv.org itself — so the branch validates too."""
    def boom(*a, **k):
        raise AssertionError("fetched without validating")

    monkeypatch.setattr(retriever, "_arxiv_get", boom)
    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo",
                        lambda host, port, *a, **k: [(2, 1, 6, "", ("127.0.0.1", port))])
    with pytest.raises(retriever.RetrievalError, match="Refusing"):
        retriever._fetch("https://arxiv.org/pdf/2201.11705")
