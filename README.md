# vault-mcp

[![CI](https://github.com/julianosirtori/vault-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/julianosirtori/vault-mcp/actions/workflows/ci.yml)
[![Status: WIP](https://img.shields.io/badge/status-WIP-orange.svg)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> [!WARNING]
> **Work in progress.** The security model and core workflows are implemented
> and tested, but the project has not reached a stable release. Expect breaking
> configuration changes, review the threat model before deployment, and do not
> treat the current `main` branch as production-ready yet.

A **remote MCP server for your Obsidian vault**. Add it once as a connector in
Claude's settings and your notes become available in any conversation — on
Claude web, iOS, Android or Desktop — with **no Obsidian desktop app required
anywhere**. The server reads the markdown files directly from disk on a small
VPS that stays in sync with your vault.

Your vault stays a folder of markdown files. No database, no proprietary
index, no custom format. If this project disappears tomorrow, your notes are
exactly where they were.

## How it works

Three zones with strictly separated responsibilities:

```
        Claude web / iOS / Android / Desktop
                        │
                        │  MCP over HTTPS (OAuth 2.1 bearer token)
                        ▼
        ┌─────────────────────────────────────┐
        │  EDGE — Cloudflare Worker           │
        │  · OAuth 2.1 + PKCE, consent page   │
        │  · token storage (Workers KV)       │
        │  · fixed redirect_uri allowlist     │
        │  · forwards with x-origin-secret    │
        │  (never stores vault content)       │
        └─────────────────────────────────────┘
                        │
                        │  Cloudflare Tunnel — outbound-only
                        │  from the VPS; no inbound ports
                        ▼
        ┌─────────────────────────────────────┐
        │  ORIGIN — your VPS                  │
        │  · mcp-server, bound to loopback    │
        │    answers 404 without the secret   │
        │  · vault-core: path validation,     │
        │    atomic writes, search            │
        │  · vault-guards: read/write         │
        │    sanitization, warn heuristics    │
        │  · ~/vault ◀─ sync client ─▶ your   │
        │    sync service (bidirectional)     │
        │  · git autocommit every 30 min      │
        └─────────────────────────────────────┘
```

The client never reaches the VPS directly. The Worker knows nothing about the
vault. The origin is not reachable from the internet — it only receives
traffic through the outbound tunnel, and answers **404** to anything that does
not carry the shared origin secret.

## The six tools

| Tool | Type | What it actually does |
| --- | --- | --- |
| `search_notes` | read | Case-insensitive **literal substring** search across markdown notes (no regex, no semantic ranking). Returns path, line number and snippet. Low-trust folders (imported clippings) are excluded unless explicitly included. |
| `read_note` | read | Full content of one note by vault-relative path. Output is sanitized (see below); very large notes are truncated and flagged. |
| `list_recent` | read | Most recently modified notes, newest first (paths and timestamps only). |
| `get_daily_note` | read | Resolves the daily note for a date (default today) using the vault's own `.obsidian/daily-notes.json` settings. If the note doesn't exist it returns the path it *would* have — it **never creates it**, and your daily-note **template is NOT applied** to notes created outside Obsidian. |
| `create_note` | write | Creates a new note. **Fails if the note already exists** — it never overwrites. Parent folders are created as needed. Writes are atomic. |
| `append_to_note` | write | Appends to the **end** of an **existing** note — the note must already exist (create it first), and existing content is never edited or overwritten. |

Remote images in written content are de-embedded into plain links before
touching disk, and note content returned to the model is stripped of channels
for invisible instructions (HTML comments, CSS-hidden elements, invisible
characters, the Unicode tag block). See the
[threat model](docs/threat-model.md) for why.

## Non-goals — on purpose

- **Single user, single vault.** One instance serves one person. Multi-tenancy
  is a **declared non-goal**: it reintroduces an entire class of isolation
  problems that simply doesn't exist today. Each user runs their own instance.
- **No Obsidian runtime.** No Templater, no Dataview, no plugins, no `eval`.
  Notes created through the server are plain markdown; plugin syntax in your
  templates will not be expanded.
- **No `delete_note`, no `move_note`.** Deliberately absent: they turn noise
  into data loss, and a bad move breaks wikilinks across every synced device.
  The minimal tool inventory is a security control, not an oversight.
- **No HTTP-request tools, no shell, no JavaScript execution.** Closing these
  channels is what keeps the worst case of a successful prompt injection at
  "junk in a note" instead of exfiltration.
- **No semantic index / embeddings** in this version. Full-text search covers
  most cases and adds no state to maintain.

## Getting started

Follow [docs/setup.md](docs/setup.md) end to end: VPS bootstrap, sync client,
tunnel, Worker deploy, and adding the connector in Claude's settings. There is
also a local-only mode for trying the server on your own machine without any
of the edge pieces.

Before hosting this, read [docs/threat-model.md](docs/threat-model.md) — you
are exposing personal notes to the internet, even behind authentication, and
you should understand exactly what protects them and what the residual risks
are. Day-2 procedures (token revocation, secret rotation, restore from git)
live in [docs/operations.md](docs/operations.md).

## Repository layout

```
apps/
  mcp-server/       MCP server on the VPS; executes the tools over HTTP
  auth-worker/      Cloudflare Worker at the edge; OAuth + authenticated proxy
packages/
  vault-core/       reading, atomic writes, path validation, search
  vault-guards/     input/output sanitization, warn-only heuristics
  tool-contract/    tool schemas and descriptions, shared
infra/
  scripts/          bootstrap · configure · start · doctor · autocommit
  systemd/          user units for server, sync, tunnel, autocommit
  tunnel/           cloudflared configuration example
docs/
  setup.md          step-by-step installation
  threat-model.md   assets, adversaries, defenses, residual risk
  operations.md     runbooks: revoke, rotate, restore
```

The architecture rationale (in Portuguese) is in
[ARCHITECTURE.md](ARCHITECTURE.md). The exact tool surface — names, schemas
and the descriptions the model sees — lives in
[packages/tool-contract/src/index.ts](packages/tool-contract/src/index.ts).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — including the dependency policy (a
server with access to personal notes is a supply-chain target) and the
standing answer to multi-tenancy requests.

## License

[MIT](LICENSE) © Juliano Sirtori
