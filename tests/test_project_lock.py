"""Task #75 — the per-project synchronous-writer readers/writer lock: the write guard refuses
while a project is reserved, and the exclusive (relocation) side drains in-flight writers
before proceeding."""
from __future__ import annotations

import threading

import pytest
from app import config


def test_write_guard_allows_when_free():
    ran = False
    with config.project_write_guard("proj-free"):
        ran = True
    assert ran


def test_write_guard_refuses_when_reserved():
    config.mark_project_busy("proj-busy")
    try:
        with pytest.raises(config.ProjectBusyError):
            with config.project_write_guard("proj-busy"):
                pass  # should not reach here
    finally:
        config.unmark_project_busy("proj-busy")


def test_write_guard_is_a_noop_without_a_pid():
    with config.project_write_guard(None):
        pass  # no lock, no busy-check — just yields


def test_exclusive_drains_an_in_flight_reader_before_proceeding():
    """A relocation's exclusive acquire must WAIT for a synchronous writer already holding the
    read guard, then proceed once it releases — the core of the #75 in-flight-writer fix."""
    pid = "proj-drain"
    reader_holding = threading.Event()
    release_reader = threading.Event()
    writer_acquired = threading.Event()

    def reader():
        with config.project_write_guard(pid):
            reader_holding.set()
            release_reader.wait(5)

    def writer():
        with config.project_exclusive(pid):
            writer_acquired.set()

    r = threading.Thread(target=reader)
    r.start()
    assert reader_holding.wait(5)

    w = threading.Thread(target=writer)
    w.start()
    # The writer cannot acquire while the reader holds the shared lock.
    assert not writer_acquired.wait(0.3)

    release_reader.set()
    assert writer_acquired.wait(5)  # reader drained ⇒ writer proceeds
    r.join(5)
    w.join(5)


def test_new_reader_waits_while_a_writer_is_pending_or_active():
    """Writer-preferring: once a relocation is waiting (or holds) the exclusive lock, a new
    synchronous writer's read guard blocks rather than slipping in ahead of it."""
    pid = "proj-writerpref"
    writer_holding = threading.Event()
    release_writer = threading.Event()
    reader_done = threading.Event()

    def writer():
        with config.project_exclusive(pid):
            writer_holding.set()
            release_writer.wait(5)

    def reader():
        with config.project_write_guard(pid):
            reader_done.set()

    w = threading.Thread(target=writer)
    w.start()
    assert writer_holding.wait(5)

    r = threading.Thread(target=reader)
    r.start()
    assert not reader_done.wait(0.3)  # blocked while the writer holds the exclusive lock

    release_writer.set()
    assert reader_done.wait(5)  # writer released ⇒ reader proceeds
    w.join(5)
    r.join(5)
