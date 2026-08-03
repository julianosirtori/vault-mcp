# infra — implementation spec

Bash, `set -euo pipefail`, shellcheck-clean style. The operational requirement:
**a reboot requires zero intervention**. Everything runs as a dedicated
unprivileged user (`vaultmcp` by default, override via env) with systemd
**user** units + linger; no sudo anywhere in the runtime path (bootstrap may
need root and must detect + re-exec or instruct).

Layout:
```
infra/scripts/bootstrap    infra/scripts/configure   infra/scripts/start
infra/scripts/doctor       infra/scripts/autocommit
infra/systemd/vault-sync.service      infra/systemd/vault-mcp.service
infra/systemd/vault-tunnel.service    infra/systemd/vault-autocommit.service
infra/systemd/vault-autocommit.timer
infra/tunnel/config.yml.example
```

Shared conventions: config lives in `~/.config/vault-mcp/env` (env file,
`chmod 600`), vault at `~/vault` by default (`VAULT_PATH`). Scripts print
clear `[vault-mcp]`-prefixed messages. Units use `%h` paths, never absolute
home paths.

## bootstrap — once per machine, idempotent, non-interactive, no secrets

Root portion (detect EUID): install system deps (git, curl, jq, xvfb noted as
optional for the sync client), create user `vaultmcp` if missing,
`loginctl enable-linger vaultmcp`. User portion: install Node 22 via system
package or verify present, `corepack enable pnpm` or verify pnpm, install
cloudflared binary if missing (document where from), create `~/vault`,
`~/.config/vault-mcp`, `~/.local/state/vault-mcp`, copy systemd user units to
`~/.config/systemd/user/`, `systemctl --user daemon-reload`, enable (not
start) all units + timer. Every step: check-then-act; safe to re-run.

## configure — once per vault, THE ONLY interactive step

Guides through: (1) sync client credential/link (the sync client command is
user-supplied — write it to `~/.config/vault-mcp/sync-command` as an
executable one-line wrapper; explain the official Obsidian CLI + Xvfb option
and warn that sync mode MUST be bidirectional — modes that revert local
changes silently destroy server writes); (2) generate `ORIGIN_SECRET`
(`openssl rand -hex 32`) into the env file; (3) write `VAULT_PATH`,
`MCP_HOST=127.0.0.1`, `MCP_PORT`, `LOW_TRUST_FOLDERS` prompts with defaults;
(4) `git init` the vault if not a repo + first commit; (5) print next steps
(tunnel credentials, Worker deploy). Never runs at boot. Refuses to overwrite
an existing env file without `--force`.

## start — every boot and every restart; non-interactive, writes nothing

Single entrypoint used by vault-mcp.service. Sources the env file; validates:
env file exists, `VAULT_PATH` exists and is a dir, `ORIGIN_SECRET` non-empty,
`node` present, server build exists (`apps/mcp-server/dist/main.js` relative
to an installed `VAULT_MCP_HOME`). Any failure → one clear line to stderr,
exit 1 (systemd will restart with backoff; the message must make `journalctl`
diagnosis instant). Then `exec node .../main.js`.

## doctor — first command when something doesn't answer

Checks, each printed as `ok|FAIL name — detail`:
unit active ×3 (sync, mcp, tunnel), env file present, vault dir present +
most recent write age, healthz via `curl -fsS -H "x-origin-secret: $ORIGIN_SECRET"
http://127.0.0.1:$MCP_PORT/healthz`, cloudflared metrics/connection state,
`vault-autocommit.timer` active + the last autocommit run's `Result` (a dead
timer is invisible to the commit-age line below — the repo and its old commits
are still there — and a silently dead autocommit is what makes "worst case is
junk in a note" false), git last commit age in vault (informational: autocommit
commits only when dirty, so it FAILs only for "not a repo"/"no commits"), last
successful sync age (newest file mtime under vault or sync unit journal
timestamp) with a WARN above 6h — "everything looks alive but content frozen in
time" is the most likely silent failure. Exit non-zero if any FAIL.

## autocommit — the recovery path that makes "worst case is junk in a note" true

cd "$VAULT_PATH"; if dirty: `git add -A && git commit -m "auto: $(date -Is)"`.
Timer: every 30 min. Never pushes (local history; remotes are the owner's call).

## systemd user units

- `vault-sync.service`: `ExecStart=%h/.config/vault-mcp/sync-command`,
  `Restart=always`, `RestartSec=5`, and (systemd ≥254)
  `RestartSteps=8` / `RestartMaxDelaySec=10min` for growing backoff —
  **never give up**: the sync client exits after prolonged network loss and a
  gives-up policy leaves sync dead for weeks. No ordering against
  `network-online.target` in any unit: that target exists only in the system
  manager, so in a user manager the dependency is silently dropped — restart
  with growing backoff is the real (and only) answer to a late network.
- `vault-mcp.service`: `ExecStart` → start script. `Wants=vault-sync.service`
  but NOT `Requires`/`After` hard-binding it — the server must serve stale
  notes when sync is broken (weak dependency is deliberate).
  `EnvironmentFile=%h/.config/vault-mcp/env`.
- `vault-tunnel.service`: `ExecStart=cloudflared tunnel --config
  %h/.config/vault-mcp/tunnel.yml run`, `After=vault-mcp.service`,
  Restart=always with the same backoff pattern.
- autocommit service (oneshot) + timer (`OnCalendar=*:0/30`, `Persistent=true`).
- All units: `[Install] WantedBy=default.target` (timer: timers.target).

## tunnel/config.yml.example

cloudflared config: named-tunnel UUID placeholder, credentials-file under
`~/.config/vault-mcp/`, one ingress rule → `http://127.0.0.1:9820`, catch-all
404. Comments explain that exposure is outbound-only.
