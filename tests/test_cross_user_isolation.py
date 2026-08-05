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
        conn.execute(
            "drop table if exists rc_account_deletions, rc_project_trash, rc_projects, rc_users, "
            "rc_schema_migrations cascade")
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
def not_dev(monkeypatch):
    """A non-dev environment, which is what makes the operator checks meaningful.

    `auth.is_operator` returns True for everyone in a dev environment so local prompt editing keeps
    working, and the suite runs as dev — so an operator test left at the default asserts nothing.
    """
    from app import config as app_config

    monkeypatch.setattr(app_config, "is_dev_env", lambda: False)
    monkeypatch.setenv("RC_OPERATOR_USERS", "")


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
    ("POST", "/api/projects/{pid}/discover/cancel"),
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
    """Uses a THIRD user who has never been seen before, deliberately.

    The first version of this used Bob, whom the fixture had already inserted into `rc_users` — so
    it stayed green with `ensure_user` removed from `claim`, while the bug it was supposed to catch
    (a newly allowlisted user has no row, so creation fails the owner foreign key AFTER writing the
    directory) reappeared. A signup test that pre-creates the user tests everything except signup.
    """
    newcomer = "9b1e77aa-3c2d-4f18-a0b5-77c1d90e4411"
    assert tenancy.owner_of("anything") is None
    with db.pool().connection() as conn:
        assert conn.execute(
            "select count(*) from rc_users where id = %s", (newcomer,)).fetchone()[0] == 0

    response = client_as(newcomer).post("/api/projects", json={"name": "First Ever"})
    assert response.status_code == 200, response.text
    pid = response.json()["project"]["id"]

    assert tenancy.owner_of(pid) == newcomer
    with db.pool().connection() as conn:
        assert conn.execute(
            "select count(*) from rc_users where id = %s", (newcomer,)).fetchone()[0] == 1
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


def test_traversal_in_the_pid_is_still_refused():
    """Ownership must not become the only check — `_safe_pid` is still the trust boundary.

    Asserted directly against `_safe_pid` rather than over HTTP. Through a route the ownership
    check now answers 404 first, so a hostile id never reaches the path boundary at all and the
    test would pass with `_safe_pid` deleted entirely — which is precisely the check it exists to
    defend. No database either: this property must hold whether or not ownership is recorded.
    """
    for hostile in ["../etc", "..", "a/b", "/abs", ".trash", "", "\x00", "a\nb"]:
        with pytest.raises(projects.ProjectError):
            projects._safe_pid(hostile)

    # And the containment guarantee the charset check backs up.
    for hostile in ["../etc", "a/b", "/abs"]:
        with pytest.raises(projects.ProjectError):
            projects.project_path(hostile)


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
def test_a_deleted_project_id_is_never_handed_out_again(two_users, client_as):
    """The ABA that made id reuse unsafe.

    A request can pass the ownership check for `foo`, and by the time it resolves paths `foo` has
    been deleted and RE-CREATED BY SOMEONE ELSE — so it reads or writes a different user's project
    while carrying an authorization that was genuine when granted. Nothing in the request carries
    the incarnation, only the string. So the id is retired rather than freed.
    """
    pid = two_users["alice"]
    assert client_as(ALICE).delete(f"/api/projects/{pid}").status_code == 200

    # Retired: nobody owns it, and it is not reachable.
    assert tenancy.owner_of(pid) is None
    assert tenancy.deleted_owner_of(pid) == ALICE
    trash_entries = projects.trashed_project_entries()
    assert len(trash_entries) == 1
    assert tenancy.trash_entries_owned_by(ALICE) == {trash_entries[0]}
    assert client_as(ALICE).get(f"/api/projects/{pid}/state").status_code == 404

    # And the id is not available to the next project of the same name — not even to Alice.
    recreated = projects.create_project("Alice Reading")
    assert recreated["id"] != pid, "a deleted project's id was handed out again"


@needs_pg
def test_a_failed_trash_move_restores_live_owner_and_clears_deleted_owner(
        two_users, monkeypatch):
    pid = two_users["alice"]

    def fail_move(*args, **kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(projects.shutil, "move", fail_move)
    with pytest.raises(OSError, match="disk unavailable"):
        projects.delete_project(pid)

    assert tenancy.owner_of(pid) == ALICE
    assert tenancy.deleted_owner_of(pid) is None
    assert tenancy.trash_entries_owned_by(ALICE) == set()


@needs_pg
def test_narration_cannot_be_billed_to_someone_elses_project(two_users, client_as):
    """The `project` field arrives in the BODY and decides whose usage ledger the spend lands on.
    Without an ownership check anyone could bill their narration to someone else — corrupting the
    attribution that M3's per-user quotas will be enforced from."""
    response = client_as(BOB).post(
        "/api/audio/jobs", json={"text": "hello", "project": two_users["alice"]})
    assert response.status_code == 400
    invented = client_as(BOB).post(
        "/api/audio/jobs", json={"text": "hello", "project": "no-such-project"})
    # Status and shape, not the exact body: the detail echoes the id the CALLER supplied, which
    # tells them nothing they did not already know. What must match is that a foreign project and
    # an invented one fail the same way.
    assert response.status_code == invented.status_code
    assert response.json().keys() == invented.json().keys()


@needs_pg
def test_the_instance_wide_usage_ledger_is_operator_only(two_users, client_as, not_dev):
    """It reports what EVERY user's unattributed activity cost — models, operations and spend.
    That is the operator's billing view, not a reader's."""
    assert client_as(BOB).get("/api/usage/unattributed").status_code == 403


@needs_pg
def test_the_cover_backfill_is_operator_only(two_users, client_as, not_dev):
    """It walks every project, reads their reading lists, and fetches PDFs from their stored
    sources — one reader causing reads across everyone's library on the instance's bandwidth."""
    assert client_as(BOB).post("/api/covers/backfill").status_code == 403


@needs_pg
def test_project_assets_are_not_cacheable_by_a_shared_cache(two_users, client_as):
    """`Cache-Control: public` on an Authorization-bearing response invites a shared cache to store
    it and serve the guessable project/paper URL to a different user, without the request ever
    reaching `use_project`."""
    from app import config as app_config
    from app.routers import covers, figures_api

    for module in (covers, figures_api):
        source = (app_config.BASE_DIR / "app" / "routers" / f"{module.__name__.split('.')[-1]}.py")
        text = source.read_text()
        assert "Cache-Control" in text
        assert '"public' not in text.split("Cache-Control")[1][:60], \
            f"{source.name} authorizes a shared cache to store a per-project asset"


@needs_pg
def test_recent_sessions_limit_applies_to_your_own_sessions(two_users, client_as):
    """The limit used to be applied globally and filtered afterwards, so a user whose neighbour had
    more recent sessions received a short — or empty — list while their own were further down a
    list they never saw."""
    from app import config as app_config
    from app import sessions, store

    # Alice gets several sessions, all newer than Bob's one.
    token = app_config.set_active_project(two_users["bob"])
    try:
        store.add_entry("Bobs Paper", arxiv_id="1111.00001")
        sessions.start_session("bobs-paper", "Bobs Paper")
    finally:
        app_config.reset_active_project(token)

    token = app_config.set_active_project(two_users["alice"])
    try:
        for n in range(5):
            store.add_entry(f"Alice Paper {n}", arxiv_id=f"2222.0000{n}")
            sessions.start_session(f"alice-paper-{n}", f"Alice Paper {n}")
    finally:
        app_config.reset_active_project(token)

    # A limit smaller than Alice's session count: Bob must still see his own.
    bob_sees = client_as(BOB).get("/api/recent-sessions?limit=3").json()["sessions"]
    assert [s["project_id"] for s in bob_sees] == [two_users["bob"]]


@needs_pg
def test_an_id_with_a_stale_ownership_row_is_never_handed_out(two_users):
    """The directory and the ownership row are two records of one fact, and they can disagree —
    a delete whose release succeeded but whose move failed, or a row from before this check
    existed. Allocating against the filesystem alone would hand a fresh project an id that still
    carries someone else's ownership row, and `record_project` refuses the conflict only AFTER the
    directory is visible, so the previous owner would already be able to read the new content.
    """
    # A row with no directory: exactly the state a half-finished delete leaves behind.
    tenancy.record_project("ghost-project", ALICE)
    assert not projects.exists("ghost-project")

    created = projects.create_project("Ghost Project")
    assert created["id"] != "ghost-project", (
        "a fresh project took an id that still carried another user's ownership row")
    assert tenancy.owner_of("ghost-project") == ALICE


@needs_pg
def test_only_one_delete_can_run_at_a_time(two_users):
    """Two concurrent DELETEs both used to enter: one moved the directory, the other's move failed
    and restored the ownership row it had just released — leaving a row for a project that no
    longer exists."""
    from app import config as app_config

    pid = two_users["alice"]
    assert app_config.mark_project_deleting(pid) is True
    assert app_config.mark_project_deleting(pid) is False, (
        "a second deletion claimed the same project")
    app_config.unmark_project_deleting(pid)

    # And the route-level refusal, so the exclusivity is not just an internal detail.
    assert app_config.mark_project_deleting(pid) is True
    try:
        with pytest.raises(projects.ProjectError, match="already being deleted"):
            projects.delete_project(pid)
    finally:
        app_config.unmark_project_deleting(pid)


def test_an_unreachable_ownership_store_is_a_503_not_a_500(tmp_path, monkeypatch, client_as):
    """A CONFIGURED but unreachable database is not the same as no database.

    With none there is nothing to record and single-tenant behaviour is right. With one that is
    down, creating anyway would produce a project with no ownership row — reachable by nobody,
    including the person who just made it. So it must fail; the point of this test is that it fails
    COMPREHENSIBLY, rather than as a ten-second PoolTimeout surfacing as a 500.
    """
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setattr(config, "PROJECTS_ROOT", root)
    monkeypatch.setenv("RC_DATABASE_URL", "postgresql://postgres:x@127.0.0.1:59999/nope")
    db.close()
    try:
        response = client_as(ALICE).post("/api/projects", json={"name": "Doomed"})
        assert response.status_code == 503
        assert "ownership" in response.json()["detail"].lower()
        assert not list(root.iterdir()), "a project was left on disk that nobody can reach"
    finally:
        db.close()


@needs_pg
def test_an_authorization_cannot_survive_into_a_different_users_project(two_users, client_as):
    """The ABA interleaving itself, not just the id-allocation rule that prevents it.

    Alice is authorized for `foo`. Alice deletes `foo`. If the id were reusable, Bob could create a
    project that lands on `foo` — and Alice's still-running request, which carries only the string,
    would then act on Bob's project with an authorization that was genuine when it was granted.
    """
    alice_pid = two_users["alice"]
    assert tenancy.owner_of(alice_pid) == ALICE          # Alice's authorization is real...
    client_as(ALICE).delete(f"/api/projects/{alice_pid}")

    # Bob now creates projects until one would have collided under the old rule.
    for _ in range(3):
        made = projects.create_project("Alice Reading")
        tenancy.claim(made["id"], {"user_id": BOB, "email": "bob@example.com"})
        assert made["id"] != alice_pid, (
            "Bob's project took the id Alice was authorized for — her in-flight request would "
            "now be operating on his content")

    # ...and the stale authorization resolves to nothing rather than to somebody else's project.
    assert client_as(ALICE).get(f"/api/projects/{alice_pid}/state").status_code == 404
    assert tenancy.owner_of(alice_pid) is None
