# Setup

End-to-end installation for self-hosting your own instance. Written for a
single user running a single vault — that is the design, not a limitation to
work around.

All hostnames below are placeholders (`vault.example.com`); use your own.

## What you need

- A Linux VPS with systemd (any small instance works; the server is I/O-bound
  on a folder of markdown files).
- A Cloudflare account with Workers and KV, and a domain managed in
  Cloudflare (for the tunnel hostname).
- A way to sync your Obsidian vault to the VPS **bidirectionally** (see
  [step 3](#3-choose-and-set-up-a-sync-client)).
- Node 22 and pnpm (via corepack) — on the VPS for the server, and on your
  machine for deploying the Worker.

## 0. Optional: try it locally first (no VPS, no tunnel, no Worker)

You can run the MCP server on your own machine against any folder of markdown
notes, with the origin secret check disabled. This is the fastest way to see
the tools working before committing to infrastructure.

```sh
corepack enable
pnpm install
pnpm build

VAULT_PATH="$HOME/my-vault" \
MCP_HOST=127.0.0.1 \
MCP_ALLOW_INSECURE_LOCAL=1 \
node apps/mcp-server/dist/main.js
```

`MCP_ALLOW_INSECURE_LOCAL=1` disables the shared-secret gate — it only takes
effect when the server is bound to loopback, and must never be set in
production.

Smoke test with curl (the server speaks MCP streamable HTTP on `POST /mcp`):

```sh
curl -s -X POST http://127.0.0.1:9820/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'
```

A JSON-RPC result with `serverInfo.name: "vault-mcp"` means it's alive. For
interactive exploration of the tools, use the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP, URL: http://127.0.0.1:9820/mcp
```

## 1. Prepare the VPS: `bootstrap`

The repository needs to end up under the dedicated user's home — bootstrap's
user portion runs from the clone itself and links its scripts into that
user's `~/.local/bin`. On a fresh machine the user doesn't exist yet, so the
first run creates it and then stops, asking you to move the clone. That loop
is expected:

```sh
git clone https://github.com/<you>/vault-mcp.git
sudo ./vault-mcp/infra/scripts/bootstrap      # first run: creates the user, then asks you to move the clone
sudo mv vault-mcp /home/vaultmcp/vault-mcp
sudo chown -R vaultmcp: /home/vaultmcp/vault-mcp
sudo /home/vaultmcp/vault-mcp/infra/scripts/bootstrap   # re-run to completion
```

`bootstrap` is idempotent, non-interactive and handles no secrets. It:

- installs system dependencies (git, curl, jq; Xvfb noted as optional for the
  official Obsidian CLI sync option);
- creates the dedicated unprivileged user (`vaultmcp` by default);
- enables **linger** for that user, so its systemd user services survive
  logout and start at boot;
- verifies/installs Node 22, pnpm (corepack) and the `cloudflared` binary
  (into `~/.local/bin`);
- creates `~/vault`, `~/.config/vault-mcp/` and state directories;
- links `start`/`doctor`/`autocommit` into `~/.local/bin` as `vault-mcp-*` —
  the systemd units call these fixed names;
- installs the systemd **user** units and enables them (enabled, not started —
  nothing runs until you've configured).

Run it again any time; every step is check-then-act.

From here on, work as the dedicated user. Note that a plain `sudo -iu
vaultmcp` shell may not have the systemd user bus; prefer:

```sh
sudo machinectl shell vaultmcp@
```

## 2. Build the server on the VPS

As the dedicated user, build the checkout bootstrap left at `~/vault-mcp`:

```sh
cd ~/vault-mcp
pnpm install
pnpm build
```

No `corepack enable` here: `bootstrap` already put `pnpm` in `~/.local/bin`
for this user, and running `corepack enable` as the unprivileged user fails
with `EACCES` — on the NodeSource layout bootstrap installs, corepack wants to
write its shims into root-owned `/usr/bin`. (If you skipped bootstrap, the
user-writable form is `corepack enable --install-directory ~/.local/bin pnpm`.
Never `sudo` it: nothing in the runtime path is meant to need root.) If
`pnpm: command not found`, `~/.local/bin` is not on this shell's `PATH`.

`configure` (step 4) records this checkout's location as `VAULT_MCP_HOME` in
the env file — that is where the start script looks for
`apps/mcp-server/dist/main.js`. If you ever move the checkout, update
`VAULT_MCP_HOME` in `~/.config/vault-mcp/env`.

## 3. Choose and set up a sync client

A separate process keeps `~/vault` in sync with your notes. The MCP server
doesn't know sync exists — it only sees files — so any client works, with one
hard requirement:

> **The sync mode MUST be bidirectional.** Revert-style modes — anything that
> treats the server copy as a mirror and reverts local changes — will
> **silently destroy every note the server writes**. A note created from chat
> would appear, then vanish on the next sync pass, with no error anywhere.

Options:

- **Official Obsidian CLI** (syncs with Obsidian Sync). It drives the
  Electron app headlessly, which on a server means running under Xvfb — it
  works, but it is a desktop app being coaxed into a server role; expect
  occasional fragility.
- **Any bidirectional file syncer** you already trust (e.g. Syncthing,
  Unison in bidirectional mode) pointed at the same folder your other devices
  sync.

Consider syncing a **subset** of your vault rather than all of it — if the
VPS is ever compromised, only what's synced is exposed (see the
[threat model](threat-model.md)).

You will hand the long-running sync command to `configure` in the next step;
it gets wrapped as `~/.config/vault-mcp/sync-command` and supervised by the
`vault-sync` systemd unit.

## 4. `configure` — the only interactive step

```sh
~/vault-mcp/infra/scripts/configure
```

This is the one script that asks questions and produces local state (it never
runs at boot, and it refuses to overwrite an existing configuration without
`--force`). It walks you through:

1. the sync client command (written to `~/.config/vault-mcp/sync-command`).
   It tells you to authenticate/link the client **first**, by hand in that
   same terminal, and what happens if you don't — the login itself is yours
   to run (every client has its own, and the unit runs unattended at boot);
2. generating `ORIGIN_SECRET` (`openssl rand -hex 32`) into the env file at
   `~/.config/vault-mcp/env` (mode 600) — you'll paste this same value into
   the Worker in step 6;
3. `VAULT_PATH`, `MCP_PORT` and `LOW_TRUST_FOLDERS` (comma-separated folders
   holding imported content — web clippings, shared notes — excluded from
   search by default). `MCP_HOST` is pinned to `127.0.0.1` and
   `VAULT_MCP_HOME` is recorded automatically from the checkout configure
   runs in — nothing to type for either;
4. `git init` of the vault plus a first commit — the autocommit timer will
   snapshot changes every 30 minutes from then on.

See [.env.example](../.env.example) for every variable and its meaning.

## 5. Create the Cloudflare Tunnel

The origin is never exposed to inbound traffic; `cloudflared` opens an
outbound connection and Cloudflare routes the tunnel hostname through it.

On the VPS, as the dedicated user:

```sh
cloudflared tunnel login
cloudflared tunnel create vault-mcp
cloudflared tunnel route dns vault-mcp vault.example.com
```

Move the generated credentials JSON under `~/.config/vault-mcp/`, then write
`~/.config/vault-mcp/tunnel.yml` based on
[infra/tunnel/config.yml.example](../infra/tunnel/config.yml.example): one
ingress rule sending `vault.example.com` to `http://127.0.0.1:9820`, then a
catch-all 404. Keep the `metrics: 127.0.0.1:9821` line — `doctor` probes
`/ready` there to verify the tunnel holds live edge connections — and give
`credentials-file` an absolute path (cloudflared does not expand `~`).

Note that reaching `vault.example.com` directly gains an attacker nothing:
without the `x-origin-secret` header that only the Worker attaches, the
origin answers 404 to everything.

## 6. Deploy the auth Worker

On your own machine (or the VPS — anywhere with wrangler):

```sh
cd apps/auth-worker
npx wrangler kv namespace create OAUTH_KV
```

Edit [apps/auth-worker/wrangler.jsonc](../apps/auth-worker/wrangler.jsonc)
(it ships with placeholder IDs only):

- the `OAUTH_KV` namespace `id` from the command above;
- `ORIGIN_URL` — the tunnel hostname, `https://vault.example.com`;
- `REDIRECT_ALLOWLIST` — comma-separated **exact** `redirect_uri` values the
  OAuth flow will accept, e.g.
  `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback`.
  Anything not exactly on this list is rejected. This is what neutralizes
  rogue dynamic client registrations — see the
  [threat model](threat-model.md).

Then set the secrets and deploy:

```sh
npx wrangler secret put ORIGIN_SECRET      # same value configure generated on the VPS
npx wrangler secret put CONSENT_PASSWORD   # high entropy, e.g.: openssl rand -base64 24
npx wrangler deploy
```

(There is no cookie secret to set: the OAuth library keeps all its state in
KV and issues no signed cookies.)

`CONSENT_PASSWORD` is what *you* type on the consent page when authorizing a
client — treat it like a password manager entry, not something memorable.
Wrong attempts are rate-limited at the edge (5 per 15 minutes per IP).

Deploy details and what the Worker can and cannot see are in
[apps/auth-worker/README.md](../apps/auth-worker/README.md).

## 7. Start everything

As the dedicated user on the VPS:

```sh
systemctl --user start vault-sync vault-mcp vault-tunnel
systemctl --user start vault-autocommit.timer
```

(Units were already *enabled* by bootstrap, so they will also start on every
boot from now on.)

## 8. Add the connector in Claude

In Claude's settings, add a custom connector pointing at the Worker's MCP
endpoint:

```
https://<your-worker>.<your-subdomain>.workers.dev/mcp
```

(or your custom Worker domain, path `/mcp`). Claude will discover the OAuth
metadata, send you to the consent page, and ask for the consent password.
After that, the vault tools are available in any conversation on any device.

Try it: *"search my notes for …"* or *"what did I write in yesterday's daily
note?"*.

## 9. Verify — now and after every reboot

```sh
~/vault-mcp/infra/scripts/doctor      # bootstrap also linked it as ~/.local/bin/vault-mcp-doctor
```

`doctor` confirms in seconds: the three units are active, the env file and
vault directory exist, the server answers its health check, the tunnel is
connected, the autocommit timer is still scheduled and its last run succeeded
(that — not the age of the last commit — is what proves the undo history is
being written), and the last successful sync is recent (it warns above 6 hours — "everything looks alive but content is
frozen in time" is the most likely silent failure).

Finally, do the real test of the central operational requirement: **reboot
the VPS and touch nothing**. When it comes back, `doctor` must be green and a
question in Claude must get an answer. If a reboot needs manual steps, the
setup is wrong — fix that now, not the day it breaks.

What each `doctor` FAIL means and every day-2 procedure (revoking tokens,
rotating secrets, restoring notes from git) is in
[operations.md](operations.md).

## Known limitations (by design — worth knowing before you rely on it)

- `create_daily_note` applies your daily-note template, rendering the core
  placeholders (`{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`) — but
  plugin syntax (Templater, etc.) is **not** executed and stays literal in the
  note. `get_daily_note` reads your vault's daily-notes settings (core Daily
  Notes or the Periodic Notes plugin; folder, filename format — a subset of
  moment tokens: `YYYY YY MMMM MMM MM M DD D dddd ddd` and `[literal]`
  escapes) so paths match what Obsidian shows, but it never creates the note
  itself.
- `append_to_note` requires the note to exist; `create_note` and `move_note`
  refuse to overwrite; `delete_note` only moves notes into the vault's own
  `.trash/` folder. `move_note` does **not** rewrite wiki-links that point at
  the old name.
- `edit_note` requires each `old_string` to match exactly once; pass the
  `version` hash from a previous read as `expected_hash` to detect concurrent
  edits (sync from another device) instead of overwriting them.
- Search is a case-insensitive **literal substring** match, not regex and not
  semantic.
- `complete_task` does not generate the next occurrence of recurring (🔁)
  tasks — open the task in Obsidian if you rely on the Tasks plugin's
  recurrence.
- Only `.md` files are reachable, and hidden folders (including `.obsidian`)
  are blocked from every tool.
