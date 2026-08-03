# Contributing

Thanks for looking at this. It's a small project with a closed scope, so the
rules are few but firm.

## Getting started

```sh
corepack enable
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

All four must pass; CI runs exactly these on Node 22 with a frozen lockfile.

## Signed commits

All commits must be **cryptographically signed** (SSH or GPG signing both
fine). This project ships code that runs with access to people's personal
notes; commit provenance is part of the security story, not ceremony.

```sh
git config commit.gpgsign true
```

Unsigned commits in a PR will be asked to be redone, not merged.

## Dependency policy

A server with read/write access to a personal vault is an attractive
supply-chain target. Therefore:

- **Minimal dependencies.** `vault-core` and `vault-guards` use `node:`
  builtins only, and that is a hard rule. Elsewhere, a new runtime dependency
  needs a stated reason why the stdlib or fifty lines of our own code won't
  do.
- **The lockfile is committed** and CI installs with `--frozen-lockfile`; a
  PR that changes `pnpm-lock.yaml` should explain why.
- Dependency updates arrive as reviewable PRs (Renovate/Dependabot style) and
  are read before merging — never auto-merged. Run `pnpm audit` when touching
  dependencies.

## Changing the tool surface

Tool names, schemas and especially **descriptions** are a product artifact —
they are what makes the model reach for the vault unprompted. Any change to
them means bumping `CONTRACT_VERSION` in
[packages/tool-contract/src/index.ts](packages/tool-contract/src/index.ts).

Any **new** tool must first answer the question from the
[threat model](docs/threat-model.md): *what happens if a malicious note gets
this tool called with arguments of its choosing?* That question is why there
is no delete, no move, no HTTP and no shell — proposals that reopen those
channels will be declined.

## Multi-tenancy: the standing answer is no

This will keep coming up, so here it is once: **vault-mcp is single-user by
design and will stay that way.** One instance, one owner, one vault.
Multi-tenancy reintroduces an entire class of isolation problems (tenant
separation in the filesystem, in tokens, in logs, in failure modes) that this
architecture deliberately does not have. Each user runs their own instance —
that's the product. PRs and issues proposing multi-tenant support will be
closed with a link to this paragraph.
