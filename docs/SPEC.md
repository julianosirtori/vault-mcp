# docs + repo meta — implementation spec

Write for a competent stranger self-hosting their own instance (M4 audience).
English. Honest about limitations. No real domains, IDs or credentials —
placeholders like `vault.example.com` only. The architecture background is in
the repo root ARCHITECTURE.md (Portuguese, source of truth for intent).

## Deliverables

- `README.md` (root): what it is (remote MCP server for an Obsidian vault —
  works from Claude web/iOS/Android, no desktop app anywhere), the three-zone
  architecture in one diagram (ASCII), the 6 tools, explicit non-goals
  (single-user BY DESIGN — multi-tenancy is a declared non-goal; no Templater/
  Dataview/plugin runtime; no delete/move tools on purpose), quickstart pointer
  to docs/setup.md, security-model pointer, license badge (MIT).
- `docs/setup.md`: end-to-end path — VPS prep (`bootstrap`), sync client
  choices (official Obsidian CLI under Xvfb, or any bidirectional syncer;
  warning: revert-style sync modes silently destroy server writes),
  `configure`, Cloudflare tunnel creation, Worker deploy (KV, secrets, vars,
  redirect allowlist), adding the connector in Claude settings, post-boot
  verification with `doctor`. Include the M1 local-only mode
  (MCP_ALLOW_INSECURE_LOCAL=1 + curl/inspector smoke test).
- `docs/threat-model.md`: assets; adversaries; the dominant threat is prompt
  injection via vault content (untrusted: clippings/PDFs/shared notes);
  defense = channel closure not detection (minimal tool inventory — no delete/
  move/HTTP/shell; remote-image de-embed on write; read sanitization: HTML
  comments, CSS-hidden, invisible chars, Unicode tag block; folder provenance);
  public URL is not a secret; origin answers 404 without the shared secret;
  redirect allowlist rationale (rogue dynamic registration); keyword filters
  are warn-only and why; git autocommit as the recovery guarantee; residual
  risks stated honestly (VPS compromise → vault exposed; mitigate by syncing a
  subset; no secrets inside the vault).
- `docs/operations.md`: runbooks written before they're needed — revoke all
  tokens (KV wipe), rotate ORIGIN_SECRET (worker secret + env file + restart
  order), rotate consent password, restore vault from git (autocommit
  history), re-link sync after credential loss, read the audit log
  (journalctl one-liners), what `doctor` checks and what each FAIL means.
- `LICENSE`: MIT, copyright Juliano Sirtori.
- `.github/workflows/ci.yml`: on push/PR — pnpm via corepack, Node 22, cache,
  `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`,
  `pnpm lint`, `pnpm test`. Single job is fine.
- `CONTRIBUTING.md` (short): signed commits policy, dependency policy (a
  server with access to personal notes is a supply-chain target: minimal deps,
  lockfile committed, renovate/audit note), and the standing answer to
  multi-tenancy requests: no — each user runs their own instance.

Cross-check claims against the SPEC.md files of core/guards/server/worker/
infra so docs never promise what code doesn't do (e.g. daily-note template NOT
applied; append requires the note to exist; search is literal substring).
