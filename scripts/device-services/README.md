# Device services (launchd)

Keeps the phone's dev setup alive on the Mac mini with nobody in the loop: whenever the Mac is
up and Kamil is logged in, the backend answers on `:8000` and Metro serves the device worktree on
`:8081`, both reachable over the tailnet. Installed 2026-10-01.

| launchd label | runs | restarts on |
|---|---|---|
| `io.scholiast.rc.backend` | `run.sh` from the **main checkout**, `RC_RELOAD=1` | exit (launchd); 5 failed minutes of `/api/health` (watchdog) |
| `io.scholiast.rc.metro` | `expo start --lan --port 8081` in **`.claude/worktrees/device-main/mobile`** | exit; 3 failed minutes of `/status`; port 8081 serving another directory; `package-lock.json` moved (reinstalls first) |
| `io.scholiast.rc.watchdog` | `watchdog.sh` every 60s | — (re-bootstraps any of the others that was unloaded) |
| `io.scholiast.rc.awake` | `caffeinate -i -s` | exit. An asleep Mac looks, from the phone, exactly like a crashed server |

```sh
scripts/device-services/install.sh            # install / update (idempotent; restarts both servers)
scripts/device-services/install.sh status     # loaded? answering? which dir does Metro serve?
scripts/device-services/install.sh uninstall
tail -f ~/Library/Logs/research-companion/{backend,metro,watchdog}.log
```

**Restart one by hand:** `launchctl kickstart -k gui/$(id -u)/io.scholiast.rc.backend`. Do not
start a second server by hand on 8000/8081: the wrappers kill a stray copy of *our* server
holding their port (narrow command-line match; anything else is left alone and logged).

**Things to know**

- The scripts are **copied** to `~/Library/Application Support/research-companion/device-services/`
  so the services never depend on what any checkout has checked out. Edit them here and re-run
  `install.sh`.
- Installing restarts the backend, which kills in-flight jobs (DR-083) — it refuses while the
  deploy status reports one; `--force` overrides.
- Deploys need nothing from this: advancing the main checkout reloads the backend (`RC_RELOAD`),
  and advancing `device-main` reaches the phone through Metro's file watching. That is why Metro
  does **not** run with `CI=1`, which turns watching off.
- Agents in `~/Library/LaunchAgents` start at **login**, not at boot. Unattended reboots need
  automatic login (System Settings → Users & Groups) — FileVault is off on this Mac, so it is
  available. Tailscale is the Homebrew `tailscaled` system daemon and is up before login.
- launchd's default soft open-files limit is 256; Metro and git blow through it and fail with
  EMFILE long after startup. The plists and `common.sh` both raise it to 65536.
