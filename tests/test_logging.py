"""app/logging_config.py: the rc.* logger setup + the project-context filter, and that the job
registry actually emits lifecycle lines through it."""
import logging
import time

import pytest
from app import committer, config, jobs, logging_config


@pytest.fixture(autouse=True)
def _restore_rc_propagate():
    """Some tests force rc propagation on to capture via caplog; restore it so logging state
    doesn't leak into the rest of the suite."""
    rc = logging.getLogger("rc")
    prev = rc.propagate
    yield
    rc.propagate = prev


def test_get_returns_namespaced_logger():
    assert logging_config.get("jobs").name == "rc.jobs"


def test_configure_is_idempotent():
    logging_config.configure()
    rc = logging.getLogger("rc")
    n = len(rc.handlers)
    logging_config.configure()  # second call must not add another handler
    assert len(rc.handlers) == n
    assert getattr(rc, "_rc_configured", False) is True


def test_project_filter_injects_active_project():
    f = logging_config._ProjectFilter()
    rec = logging.LogRecord("rc.x", logging.INFO, "f", 1, "msg", None, None)
    token = config.set_active_project("proj-xyz")
    try:
        f.filter(rec)
        assert rec.project == "proj-xyz"
    finally:
        config.reset_active_project(token)


def test_project_filter_defaults_to_dash_without_a_project():
    f = logging_config._ProjectFilter()
    rec = logging.LogRecord("rc.x", logging.INFO, "f", 1, "msg", None, None)
    f.filter(rec)
    assert rec.project == "-"


# ---- the registry emits through rc.jobs ----

def _capture(caplog):
    """Force rc.* records to propagate to caplog's root handler regardless of whether
    configure() (which sets propagate=False) has run elsewhere in the suite."""
    rc = logging.getLogger("rc")
    rc.propagate = True
    caplog.set_level(logging.INFO, logger="rc")


def _wait_for_log(caplog, predicate, timeout=2.0):
    """Poll caplog for an rc.jobs record matching predicate — the terminal log fires just after
    the status flip, so waiting on the message (not the status) avoids that race."""
    end = time.time() + timeout
    while time.time() < end:
        if any(predicate(r.getMessage()) for r in caplog.records if r.name == "rc.jobs"):
            return
        time.sleep(0.01)
    seen = [r.getMessage() for r in caplog.records if r.name == "rc.jobs"]
    raise AssertionError(f"expected log not seen; got {seen}")


def test_registry_logs_start_and_done(caplog):
    _capture(caplog)
    reg = jobs.JobRegistry("demo")
    reg.start_or_join("k1", lambda: jobs.Job(id=jobs.new_id()), lambda j: None)
    _wait_for_log(caplog, lambda m: m.startswith("done demo"))
    msgs = [r.getMessage() for r in caplog.records if r.name == "rc.jobs"]
    assert any(m.startswith("start demo") for m in msgs)


def test_registry_logs_error_on_worker_exception(caplog):
    _capture(caplog)
    reg = jobs.JobRegistry("demo")

    def boom(job):
        raise RuntimeError("kaboom")

    reg.start_or_join("k2", lambda: jobs.Job(id=jobs.new_id()), boom)
    _wait_for_log(caplog, lambda m: m.startswith("error demo") and "kaboom" in m)


def _rec(caplog, predicate):
    return next(r for r in caplog.records if r.name == "rc.jobs" and predicate(r.getMessage()))


def test_lifecycle_lines_tagged_with_explicit_project_not_ambient(caplog):
    # Project A starts a job explicitly for project B: every lifecycle line must read B, even the
    # start line, which is emitted on A's request thread.
    _capture(caplog)
    reg = jobs.JobRegistry("demo")
    token = config.set_active_project("ambient-A")
    try:
        reg.start_or_join("k", lambda: jobs.Job(id=jobs.new_id()), lambda j: None,
                          project_id="proj-B")
        _wait_for_log(caplog, lambda m: m.startswith("done demo"))
    finally:
        config.reset_active_project(token)
    assert _rec(caplog, lambda m: m.startswith("start demo")).project == "proj-B"
    assert _rec(caplog, lambda m: m.startswith("done demo")).project == "proj-B"


def test_app_global_job_tagged_dash_even_from_a_project_request(caplog):
    # An app-global job (project_id=None, e.g. audio) started from within a project request must
    # be tagged '-', not the requesting project.
    _capture(caplog)
    reg = jobs.JobRegistry("audio")
    token = config.set_active_project("ambient-A")
    try:
        reg.start_or_join("k", lambda: jobs.Job(id=jobs.new_id()), lambda j: None, project_id=None)
        _wait_for_log(caplog, lambda m: m.startswith("done audio"))
    finally:
        config.reset_active_project(token)
    assert _rec(caplog, lambda m: m.startswith("start audio")).project == "-"


def test_the_handler_follows_sys_stderr_rather_than_capturing_it(capfd):
    """`configure()` runs when `app.main` is imported, and under pytest that is inside whichever
    test imports it first — with capture active. A handler holding that stream object writes every
    later line into a torn-down capture buffer, so an unrelated test asserting on stderr fails
    depending only on which test file sorts first. Bound at emit time instead."""
    import sys
    from io import StringIO

    logging_config.configure()
    handler = next(h for h in logging.getLogger("rc").handlers
                   if isinstance(h, logging_config._CurrentStderrHandler))

    replacement = StringIO()
    original, sys.stderr = sys.stderr, replacement
    try:
        assert handler.stream is replacement
        logging_config.get("test").warning("follows the current stream")
    finally:
        sys.stderr = original
    assert "follows the current stream" in replacement.getvalue()
    assert handler.stream is original


def test_committer_log_identifies_commit_without_private_summary(monkeypatch, caplog):
    """The approved summary belongs in git and the API response, not the hosting log."""
    _capture(caplog)
    secret = "private finding about an unpublished result"

    monkeypatch.setattr(committer.store, "title_for", lambda _slug: "Private Paper")
    monkeypatch.setattr(committer.store, "append_notes_block", lambda *_args: None)
    monkeypatch.setattr(committer.store, "set_status_read", lambda *_args: None)
    monkeypatch.setattr(committer.sessions, "finalize_proposal_for_commit", lambda _slug: None)
    monkeypatch.setattr(committer.sessions, "mark_committed", lambda _slug: None)
    monkeypatch.setattr(
        committer,
        "_git",
        lambda *args: "abc123" if args == ("rev-parse", "--short", "HEAD") else "",
    )

    result = committer.commit("private-paper", "## Notes\n\nSensitive.", "", secret)

    assert result["message"] == secret  # still part of the approved project/API contract
    messages = [record.getMessage() for record in caplog.records
                if record.name == "rc.committer"]
    # Under the full suite configure() has already installed rc's stderr handler, while _capture
    # also propagates into pytest's root handler. Some logging/plugin combinations expose the same
    # record twice through caplog; privacy depends on every copy's content, not the capture count.
    assert messages
    assert set(messages) == {"commit slug=private-paper rev=abc123"}
    assert secret not in caplog.text
