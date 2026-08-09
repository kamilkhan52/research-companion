# Device-test runbook

*Split out of [`10-roadmap.md`](10-roadmap.md) on 2026-08-09 — it is procedure, not a ledger entry.
Verified 2026-07-28. Run it before saying "ready to test": the point is to prove what is actually
being served, not that some server is up.*

The trap this exists to prevent: a Metro server can be running, healthy, and serving *the wrong
worktree*. On 2026-07-28 it was being kept alive by a launchd agent, `com.paradigm.metro.auth-ui`,
pinned to `.claude/worktrees/m2-auth-ui` — ten commits behind `main` — and it respawned twice after
being killed before the agent was found. Its plist lived in `/private/tmp`, not
`~/Library/LaunchAgents`, so it did not show up in the obvious place. `launchctl list | grep -i
metro` is what finds it.

So: **prove what is served, never that a server is up.**

- Metro's actual working directory: `lsof -a -p $(lsof -ti :8081) -d cwd`.
- Route modules are **absent from `index.bundle`** — `AuthGate` lives in `_layout`, so fetch
  `http://127.0.0.1:8081/src/app/_layout.bundle?platform=android&dev=true&minify=false` and grep
  it for a string only the new code contains. On 2026-07-28: `Your account was deleted` and
  `accountDeletedNotice.v1` both present, and the same key present in `delete-account.bundle`.
- Backend: `curl http://100.83.161.127:8000/api/health`; Metro over the tailnet:
  `curl http://100.83.161.127:8081/status`. Both must answer from the phone's network, not just
  loopback.
- The phone is `oneplus-15` (`100.79.189.127`) and was directly connected on the tailnet.

**For anything auth-gated, point the app at staging** — Settings → server URL →
`https://research-companion-staging.fly.dev`. `app.json`'s baked `extra.apiBaseUrl` is the Mac's
tailnet address, which is the open-auth instance.
