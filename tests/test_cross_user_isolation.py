"""One user must not reach another user's project. The whole point of M2.

Written BEFORE the enforcement it describes, and deliberately driven through `TestClient` rather
than by calling `use_project` directly: the property that matters is what an HTTP caller can reach,
and that runs through the auth middleware, the router's dependency, and the contextvar binding
together. A unit test of the dependency would pass while any one of those three was miswired.

Every project route in the app hangs off `routers.make_project_router()`, which binds
`use_project` once — so that dependency is the single choke point, and these tests exercise it
through several route families rather than all 73 routes.
"""
from __future__ import annotations

import os

import pytest
from app import config, db, projects, tenancy

ALICE = "f4a33e1b-b3c4-4eb2-a0ea-d110b36a072e"
BOB = "c3fa116b-f010-4d95-8aae-6dc13e1292a4"

TEST_DB = os.environ.get("RC_TEST_DATABASE_URL", "").strip()
needs_pg = pytest.mark.skipif(not TEST_DB, reason="set RC_TEST_DATABASE_URL to run these")


@pytest.fixture
def two_users(tmp_path, monkeypatch):
    """Alice and Bob, each owning one project, on a migrated empty schema.

    Both projects are created through `projects.create_project` so they are real repositories on
    disk — the isolation being tested is about who may REACH them, and a fixture that only wrote
    database rows would prove nothing about the filesystem side.
    """
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setattr(config, "PROJECTS_ROOT", root)
    monkeypatch.setenv("RC_DATABASE_URL", TEST_DB)
    db.close()
    with db.pool().connection() as conn:
        conn.execute("drop table if exists rc_projects, rc_users, rc_schema_migrations cascade")
    db.migrate()

    tenancy.ensure_user(ALICE, "alice@example.com")
    tenancy.ensure_user(BOB, "bob@example.com")
    alice_pid = projects.create_project("Alice Reading")["id"]
    bob_pid = projects.create_project("Bob Reading")["id"]
    tenancy.record_project(alice_pid, ALICE)
    tenancy.record_project(bob_pid, BOB)

    yield {"alice": alice_pid, "bob": bob_pid}
    db.close()


@pytest.fixture
def client_as(monkeypatch):
    """A TestClient authenticated as a chosen user, going through the real auth middleware."""
    from app import auth
    from app.main import app
    from starlette.testclient import TestClient

    def _make(user_id: str):
        monkeypatch.setattr(auth, "enabled", lambda: True)
        monkeypatch.setattr(auth, "mode", lambda: "supabase")
        monkeypatch.setattr(
            auth, "check", lambda _t: {"user_id": user_id, "email": f"{user_id}@example.com"})
        return TestClient(app, headers={"Authorization": "Bearer test"})

    return _make


# --- the property, one test per route family ---------------------------------------------------

@needs_pg
@pytest.mark.parametrize("method,path", [
    ("GET", "/api/projects/{pid}/state"),
    ("GET", "/api/projects/{pid}/usage"),
    ("GET", "/api/projects/{pid}/graph"),
    ("POST", "/api/projects/{pid}/discover"),
    ("POST", "/api/projects/{pid}/papers"),
    ("PATCH", "/api/projects/{pid}/meta"),
    ("GET", "/api/projects/{pid}/meta"),
    ("DELETE", "/api/projects/{pid}"),
])
def test_bob_cannot_reach_alices_project(two_users, client_as, method, path):
    """404, not 403: telling Bob "forbidden" would confirm that Alice's project id exists. Project
    ids are derived from names, so confirming one leaks what she is reading."""
    client = client_as(BOB)
    # A body the route will accept, so validation cannot 400 before ownership is consulted — that
    # would make the test pass for the wrong reason.
    body = {"name": "renamed by bob"} if method == "PATCH" else {}
    real = client.request(method, path.format(pid=two_users["alice"]), json=body)
    assert real.status_code == 404, (
        f"{method} {path} returned {real.status_code} — Bob reached Alice's project")

    # Indistinguishable from a project that never existed. Asserting the two responses match is
    # stronger than checking the body omits the id — the id came from Bob's own request, so
    # echoing it tells him nothing, whereas a DIFFERENT status or shape would tell him Alice's
    # project is real. Project ids are derived from names, so that is a disclosure.
    invented = client.request(method, path.format(pid="no-such-project-here"), json=body)
    assert (real.status_code, real.json().keys()) == (invented.status_code, invented.json().keys())


@needs_pg
def test_alice_can_still_reach_her_own(two_users, client_as):
    """The guard that keeps every test above honest: refusing EVERYONE would satisfy them all."""
    response = client_as(ALICE).get(f"/api/projects/{two_users['alice']}/state")
    assert response.status_code == 200


@needs_pg
def test_the_project_list_shows_only_your_own(two_users, client_as):
    alice_sees = {p["id"] for p in client_as(ALICE).get("/api/projects").json()["projects"]}
    bob_sees = {p["id"] for p in client_as(BOB).get("/api/projects").json()["projects"]}

    assert alice_sees == {two_users["alice"]}
    assert bob_sees == {two_users["bob"]}
    assert not alice_sees & bob_sees


@needs_pg
def test_an_unowned_project_is_not_visible_to_anyone(two_users, client_as):
    """A project on disk with no ownership row — an import that predates adoption, or a directory
    dropped in by hand. It must not become everyone's: defaulting to visible is how a migration gap
    turns into a data leak."""
    orphan = projects.create_project("Nobody's")["id"]  # deliberately not recorded

    for user in (ALICE, BOB):
        client = client_as(user)
        assert orphan not in {p["id"] for p in client.get("/api/projects").json()["projects"]}
        assert client.get(f"/api/projects/{orphan}/state").status_code == 404


@needs_pg
def test_creating_a_project_records_the_creator_as_owner(two_users, client_as):
    response = client_as(BOB).post("/api/projects", json={"name": "Bob's Second"})
    assert response.status_code == 200
    pid = response.json()["project"]["id"]
    assert tenancy.owner_of(pid) == BOB
    assert client_as(ALICE).get(f"/api/projects/{pid}/state").status_code == 404


@needs_pg
def test_isolation_holds_when_both_users_use_the_same_project_id(two_users, client_as, tmp_path):
    """The case a pid-only check gets wrong.

    Ownership is keyed by project id, and ids are globally unique TODAY — but a test that gives the
    two users different ids proves only that different ids are different. This asserts the
    property that must survive per-user namespacing later: whatever id Bob holds, the answer to
    "may Bob read this" comes from the owner, not from the id's shape.
    """
    alice_pid = two_users["alice"]
    assert tenancy.owner_of(alice_pid) == ALICE

    # Bob asks for Alice's id directly — the only way he could collide with her today.
    assert client_as(BOB).get(f"/api/projects/{alice_pid}/state").status_code == 404
    assert client_as(ALICE).get(f"/api/projects/{alice_pid}/state").status_code == 200


@needs_pg
def test_traversal_in_the_pid_is_still_refused(two_users, client_as):
    """Ownership must not become the only check — `_safe_pid` is still the trust boundary."""
    client = client_as(ALICE)
    for hostile in ["..%2f..%2fetc", "%2e%2e%2f", "a/b"]:
        assert client.get(f"/api/projects/{hostile}/state").status_code in (403, 404, 422)


# --- without a database, nothing changes -------------------------------------------------------

def test_with_no_database_every_project_is_reachable_as_before(tmp_path, monkeypatch, client_as):
    """Single-tenant fallback. `./run.sh` has no database, and this is what keeps it working —
    enforcement that fails CLOSED when the secret is missing would take the app down."""
    monkeypatch.delenv("RC_DATABASE_URL", raising=False)
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setattr(config, "PROJECTS_ROOT", root)
    pid = projects.create_project("Solo")["id"]

    response = client_as(ALICE).get(f"/api/projects/{pid}/state")
    assert response.status_code == 200


# --- routes that take a project id somewhere OTHER than the path -------------------------------
# None of these acquire `use_project`, and none were covered by the parametrized cases above. Each
# was reachable across users until this slice; they are the reason "one choke point" was wrong
# twice.

@needs_pg
def test_recent_sessions_shows_only_your_own(two_users, client_as):
    """Cross-project by design, so it enumerates every project on disk — and was returning every
    user's project names, paper titles and source URLs to anyone signed in.

    Alice gets a REAL session first. An earlier version of this test asserted against two freshly
    created projects, which have no session activity at all: the endpoint returned an empty list
    either way, so it passed with the filtering removed. Seeding is what makes it a test.
    """
    from app import config as app_config
    from app import sessions, store

    token = app_config.set_active_project(two_users["alice"])
    try:
        store.add_entry("Attention Is All You Need", arxiv_id="1706.03762")
        sessions.start_session("attention-is-all-you-need", "Attention Is All You Need")
    finally:
        app_config.reset_active_project(token)

    # Alice sees her own session, so the endpoint is genuinely returning something.
    assert any(s["project_id"] == two_users["alice"]
               for s in client_as(ALICE).get("/api/recent-sessions").json()["sessions"])

    bob_sees = client_as(BOB).get("/api/recent-sessions").json()["sessions"]
    assert two_users["alice"] not in {s["project_id"] for s in bob_sees}
    assert all(s["project_id"] == two_users["bob"] for s in bob_sees)


@needs_pg
def test_the_duplicate_preflight_does_not_search_other_libraries(two_users, client_as):
    """`/paper-matches` reports where else a paper already is. Unscoped, that is a search across
    everyone's reading lists: submit a title, learn who else has it and what they called their
    project."""
    from app import config as app_config

    token = app_config.set_active_project(two_users["alice"])
    try:
        from app import store
        store.add_entry("Attention Is All You Need", arxiv_id="1706.03762")
    finally:
        app_config.reset_active_project(token)

    response = client_as(BOB).post(
        f"/api/projects/{two_users['bob']}/paper-matches",
        json={"title": "Attention Is All You Need", "arxiv_id": "1706.03762"})
    assert response.status_code == 200
    assert response.json()["matches"] == [], "Bob was shown a paper in Alice's project"


@needs_pg
def test_prompts_cannot_be_scoped_to_someone_elses_project(two_users, client_as):
    """The project id arrives as a QUERY parameter, so this route never sees `use_project` — and
    `reading-method.md` is a document its owner wrote."""
    response = client_as(BOB).get(f"/api/prompts?project={two_users['alice']}")
    assert response.status_code == 404


@needs_pg
def test_papers_cannot_be_moved_into_someone_elses_project(two_users, client_as):
    """`dest_pid` arrives in the BODY. This is a write, not a read: without the check Alice could
    push her papers into Bob's git-backed record, and the distinct busy/deleting responses would
    disclose his project's state on the way."""
    response = client_as(ALICE).post(
        f"/api/projects/{two_users['alice']}/move",
        json={"dest_pid": two_users["bob"], "slugs": ["anything"]})
    assert response.status_code == 404
    invented = client_as(ALICE).post(
        f"/api/projects/{two_users['alice']}/move",
        json={"dest_pid": "no-such-project", "slugs": ["anything"]})
    assert response.status_code == invented.status_code


@needs_pg
def test_a_deleted_project_id_can_be_reused_by_someone_else(two_users, client_as):
    """Deleting trashes the directory, which frees the id for reuse. A surviving ownership row
    would silently give the next project with that id to the previous owner — its creator unable
    to open it, and the previous owner able to read content that is not theirs."""
    pid = two_users["alice"]
    assert client_as(ALICE).delete(f"/api/projects/{pid}").status_code == 200
    assert tenancy.owner_of(pid) is None

    tenancy.claim(pid, {"user_id": BOB, "email": "bob@example.com"})
    assert tenancy.owner_of(pid) == BOB
