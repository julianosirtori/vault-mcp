# Operations

Runbooks written before they're needed. When something is wrong, start with
`doctor` (bottom of this page), then pick the procedure.

Conventions: the dedicated user is `vaultmcp`, config lives in
`~/.config/vault-mcp/env`, the vault in `~/vault`, the repo in
`~/vault-mcp`. Run `systemctl --user` commands as that user (e.g. via
`sudo machinectl shell vaultmcp@`). Wrangler commands run from
`apps/auth-worker/` in the repo checkout; wrangler's KV flag syntax has
shifted between versions, so check `npx wrangler kv --help` if a flag is
rejected.

## Revoke all tokens (KV wipe)

When: a device is lost, a token may have leaked, or you just want every
client to re-authorize.

All OAuth state — grants, tokens, plus the consent rate-limit counters —
lives in the `OAUTH_KV` namespace. Deleting every key revokes everything at
once (deleting the rate-limit counters too is harmless):

```sh
cd apps/auth-worker
npx wrangler kv key list --binding OAUTH_KV --remote \
  | jq -r '.[].name' \
  | while IFS= read -r k; do npx wrangler kv key delete --binding OAUTH_KV --remote "$k"; done
```

(For large key counts, `wrangler kv bulk delete` with a JSON file of key
names does the same in one call.)

Effect: every connected client's next request fails auth and it must go
through the OAuth flow again — you will be asked for the consent password.
The origin and vault are untouched.

## Rotate ORIGIN_SECRET

When: on suspicion of leak, or on schedule. The origin accepts exactly one
secret, so expect a brief window (seconds) of 404s between the two halves —
do them back to back.

1. Generate the new value: `openssl rand -hex 32`
2. On the VPS: edit `~/.config/vault-mcp/env`, replace the `ORIGIN_SECRET=`
   value.
3. Restart the server so it loads the new value:
   `systemctl --user restart vault-mcp`
4. Immediately update the Worker (this redeploys it):
   `cd apps/auth-worker && npx wrangler secret put ORIGIN_SECRET`
   — paste the same value.
5. Verify: `~/vault-mcp/infra/scripts/doctor` (healthz uses the env-file
   secret), then a tool call from a Claude conversation end to end.

If step 4 is forgotten, every proxied request returns 404 — that is the
designed behavior of a secret mismatch, and `doctor` passing locally while
Claude gets nothing is the telltale.

## Rotate the consent password

When: on suspicion, or after typing it anywhere questionable.

```sh
openssl rand -base64 24        # new value, store it in your password manager
cd apps/auth-worker
npx wrangler secret put CONSENT_PASSWORD
```

Note: the consent password only guards **new** authorizations. Tokens already
granted keep working. If the reason for rotating implies the old password may
have been used by someone else, also do the KV wipe above to force every
client back through consent.

## Restore vault content from git

When: junk got written, a note was mangled, or you want to see what changed.
The autocommit timer snapshots the vault every 30 minutes, so the local git
history is your undo path.

Inspect first:

```sh
cd ~/vault
git log --oneline -20                        # recent snapshots ("auto: <timestamp>")
git log --oneline -- 'path/to/note.md'       # history of one note
git diff HEAD~1 -- 'path/to/note.md'         # what the last snapshot changed
```

Restore a single note to a known-good state, and commit the restore so the
history stays linear:

```sh
git restore --source <commit> -- 'path/to/note.md'
git add -A && git commit -m "restore: path/to/note.md from <commit>"
```

Two cautions:

- **Sync propagates the restore** to every device within seconds — which is
  what you want for a single note, and exactly why you should **not** hard-
  reset the whole vault (`git reset --hard`) unless you truly intend every
  device to receive that state, deletions included.
- Changes made on other devices since the snapshot are also in the working
  tree; restore specific paths, not the world.

Also remember the write tools cannot delete or overwrite notes — so "restore"
is usually about removing appended junk or a junk note, not recovering a
destroyed one.

## Re-link sync after credential loss

When: `doctor` warns the last sync is stale and `vault-sync` logs show
authentication errors, or you rotated your sync-service credentials.

1. Stop the unit: `systemctl --user stop vault-sync`
2. Re-authenticate the sync client manually, the same way `configure` guided
   you the first time (for the official Obsidian CLI that means running its
   login under Xvfb; for other syncers, their own re-auth flow).
3. If the launch command changed, update the one-line wrapper at
   `~/.config/vault-mcp/sync-command` (keep it executable).
4. Start and watch: `systemctl --user start vault-sync` then
   `journalctl --user -u vault-sync -f` until you see a successful pass.
5. Confirm with `~/vault-mcp/infra/scripts/doctor` — the last-sync age check
   must be green.

Reminder while you're in there: the sync mode must remain **bidirectional**.
A revert-style mode silently destroys server writes.

## Read the audit log

Every tool call is one JSON line on the server's stdout —
`{ ts, tool, path?, ok, bytes, ms, error? }` — captured by journald.

That journal is **not** pure JSON: systemd's own `Starting…`/`Started…` lines,
the server's stderr (`[vault-mcp] SIGTERM received…`) and the `start` script's
failure lines share the stream. Plain `jq` stops at the first of them with
`parse error: Invalid numeric literal` and prints nothing after it — which
reads exactly like "the audit log was never written". So every recipe below
takes the lines as raw text (`-R`) and runs them through `fromjson?`, which
drops whatever is not JSON instead of killing the pipeline.

```sh
# follow live
journalctl --user -u vault-mcp.service -f

# today's tool calls, one JSON object per line
journalctl --user -u vault-mcp.service -o cat --since today \
  | jq -cR 'fromjson? // empty | select(type == "object" and .tool != null)'

# failures only
journalctl --user -u vault-mcp.service -o cat --since today \
  | jq -cR 'fromjson? // empty | select(type == "object" and .tool != null and .ok == false)'

# every write, as "time tool path"
journalctl --user -u vault-mcp.service -o cat \
  | jq -rR 'fromjson? // empty | select(type == "object" and (.tool == "create_note" or .tool == "append_to_note")) | [.ts, .tool, .path] | @tsv'
```

Authentication events happen at the edge, not the origin: consent attempts
and OAuth failures are in the Worker's logs (`npx wrangler tail` from
`apps/auth-worker/`). In a single-user system **any** auth failure is
anomalous and worth a look.

## `doctor`: what it checks and what a FAIL means

`~/vault-mcp/infra/scripts/doctor` prints one `ok|FAIL` line per check and
exits non-zero if any check fails. Run it first, before reading logs.

| Check | FAIL means | First move |
| --- | --- | --- |
| `vault-sync` unit active | Sync process is down; content will go stale silently. | `journalctl --user -u vault-sync -e`; auth errors → [re-link sync](#re-link-sync-after-credential-loss). |
| `vault-mcp` unit active | Server not running. The `start` script fails fast with a single clear line when a precondition is missing (env file, `VAULT_PATH`, `ORIGIN_SECRET`, node, build). | `journalctl --user -u vault-mcp -e` — the last line names the missing piece. |
| `vault-tunnel` unit active | cloudflared is down; the edge cannot reach the origin at all. | `journalctl --user -u vault-tunnel -e`; check `~/.config/vault-mcp/tunnel.yml` and credentials file. |
| env file present | `~/.config/vault-mcp/env` missing — `configure` never ran here, or the file was removed. | Run `infra/scripts/configure` (it refuses to clobber an existing file without `--force`). |
| vault dir present + recent write | `VAULT_PATH` wrong, or sync has never delivered files. | Check the env file's `VAULT_PATH`; then the sync unit. |
| healthz answers | Server process is up but not serving, or the secret in the env file doesn't match what the server loaded (healthz requires the secret; mismatch → 404). | Restart `vault-mcp`; if it persists, compare env file vs. runbook history of [ORIGIN_SECRET rotation](#rotate-origin_secret). |
| cloudflared connected | Tunnel process has no live connection to Cloudflare (egress blocked, DNS, account issue) — or `~/.config/vault-mcp/tunnel.yml` is missing the `metrics: 127.0.0.1:9821` line `doctor` probes for `/ready`. | `journalctl --user -u vault-tunnel -e`; verify outbound connectivity and the `metrics:` line. |
| `vault-autocommit.timer` active + last run's result | Autocommit isn't running (or fails every run) — your undo history is not being written, and the "worst case is junk in a note" promise no longer holds. | `systemctl --user start vault-autocommit.timer`; `systemctl --user list-timers`; `journalctl --user -u vault-autocommit.service -e`. |
| git last commit age | Only FAILs when the vault is not a git repo at all, or has no commit yet — i.e. `configure` never finished here. The age itself is reported, never failed on: autocommit commits only when the vault is dirty, so an old snapshot on a quiet vault is normal (whether snapshotting still *works* is the timer row above). | Run `infra/scripts/configure`. |
| last successful sync age (WARN > 6 h) | **The most likely silent failure**: everything answers, but content is frozen in time. | Same path as the sync unit check; verify a change made on another device arrives on the VPS. |

The end-to-end check `doctor` cannot do: open a Claude conversation and ask
something that needs the vault. If `doctor` is green but Claude fails, the
problem is in the edge half — Worker logs (`npx wrangler tail`) and the KV/
secret state are the next stop.
