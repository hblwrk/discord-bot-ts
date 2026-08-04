# CLAUDE.md

Coding guidance for this repo. Extracts the rules a contributor (human or agent) needs to write code that passes CI and runs in production. README.md remains the source of truth for setup, secrets, and operations.

## Stack

- TypeScript with native ESNext modules. **No build step** — runtime is `node index.ts` through Node.js native TypeScript support. Don't add `tsc` emit, a `dist/` directory, or a bundler.
- Node 24 LTS only (`.nvmrc` resolves to Node 24; image is `node:24` builder + `gcr.io/distroless/nodejs24:nonroot` runtime).
- discord.js v14, Express v5 (healthcheck only), Winston, axios, ws, node-schedule.
- Vitest for tests. `npm run typecheck` checks the production config and the test config — there is no separate compile.

## Code conventions

- Relative imports use the `.ts` extension in source files so Node.js can run the TypeScript sources natively. Example: `import {x} from "./foo.ts";`.
- Local style: 2-space indent, double quotes, explicit readable control flow — match the surrounding file.
- One feature per module under `modules/<feature>.ts`, with `<feature>.test.ts` alongside. `index.ts` only wires startup; feature logic does not belong there.
- Keep modules under ~800 lines. Split before adding more.
- Don't introduce code that requires a shell, package manager, or writable filesystem at runtime — the production image is distroless, nonroot, read-only. Writes only go to `/dev/shm` (set as `TMPDIR`).

## Tests, types, and coverage

- The CI `test` job runs four gates in this order: `npm audit --audit-level=high`, `npm run lint`, `npm run test:coverage`, `npm run typecheck`. Run all four locally — a green test run still fails CI on a lint error, and the audit gate fails on advisories that have nothing to do with your change.
- `vitest.config.ts` enforces global thresholds (85/85/84/80 stmt/lines/funcs/branches) and stricter per-module thresholds for several modules in `modules/` (90–100% in some). Don't lower a threshold to make a change pass — write the test, or split the module.
- Tests use `*.test.ts` next to the source file; `modules/test-utils/` is excluded from coverage.
- A green suite does not mean a fix is pinned. Hand-written fixtures are simplified documents that usually offer a second path to the right answer, so deleting the guard you just added often changes nothing and the suite stays green. For parsing and value-selection work, check by mutation: neutralise the guard (`return false`, or drop the score term), run the suite, restore. If nothing fails, the test asserts an outcome rather than the rule. A rule expressed as a bonus/penalty pair needs both halves removed to show up.
- Prefer omitting a metric over publishing a wrong one. A figure that cannot be selected confidently should be left out — a missing line reads as incomplete, a wrong one reads as authoritative.

## Real-document fixtures

`modules/test-fixtures/earnings-filings/` holds audited SEC earnings exhibits, asserted by `earnings-results-corpus.test.ts`. They exist because the earnings parser selects between competing candidates in one document — a prior-year column, a segment breakdown, a guidance range — and only a whole filing exercises that choice.

- Treat the corpus as append-only. Don't delete a fixture, trim it down, or reduce it to the lines that currently matter: the distractors are the test. A minimised fixture stops catching the case it was added for.
- Fix a mis-parse against a real filing, then add that filing. Fetch with `curl -A "hblwrk discord-bot-ts admin@hblwrk.de"` — sec.gov answers 403 to a default or absent User-Agent, so it needs the declaring one from `earnings-results-sec.ts`. Store the `htmlToText` output rather than the HTML, and confirm the stored text parses identically to the original before relying on it.
- Verify each expected figure against the source document by hand, and keep them in the test's table where a reviewer can read them. Never update an expectation to match new output without checking the filing again — that converts a regression into a recorded fact.

## Configuration & secrets

- Local dev reads `config.json` at the repo root. It contains secrets — gitignored, never log it, never paste contents into commits, PRs, or external tools.
- Production reads Docker secrets prefixed by environment: `production_*` or `staging_*`. Resolution is environment-scoped — exactly one prefix is mounted, selected by the `environment` secret. Mounting both, or neither, is a startup error. Don't add code paths that read both prefixes or fall back across them.
- `HEALTHCHECK_PORT` (default 11312) and `LOGLEVEL` are the env-var overrides recognised by the bot. `healthcheck.js` calls `/api/v1/health`; keep that endpoint working when touching the HTTP server.

## CI/CD invariants

- `main` is the released branch. All work goes via feature branches and PRs.
- The CI pipeline runs: audit + lint + tests + typecheck → Dockerfile validator + Checkov + Sysdig CIS benchmark → image build/push to `ghcr.io` → Trivy scan (HIGH/CRITICAL, fixed only) → cosign sign → webhook redeploy by image digest. Staging must report `/api/v1/ready` before production rolls.
- A new advisory can fail `npm audit` on `main`, which blocks the required `test` check on every open PR including Dependabot's. Fix it in its own lockfile-only PR and merge that first, rather than folding it into unrelated work or weakening the gate.
- Separate workflows run CodeQL, njsscan, and Semgrep. Treat their findings as blocking.
- Don't loosen any of: `coverageThreshold`, `npm audit --audit-level=high`, Trivy severity filters, Checkov framework scope, image signing, or the staging readiness gate. If one is genuinely the wrong fit, raise it explicitly rather than editing it through.

## Commit signing

- Commits and tags in this repo are **SSH-signed, not GPG-signed**. The repo-local git config sets `gpg.format=ssh`, `commit.gpgsign=true`, and `tag.gpgsign=true`. Don't switch `gpg.format` to `openpgp`/GPG, and don't disable signing to make a commit go through — if signing fails, fix the key setup instead.
- No PII in commits. The author/committer identity must be a GitHub handle plus that account's `…@users.noreply.github.com` privacy email — never a real name or a real-domain email. The SSH signature embeds only the public key bytes, not the key file's comment, so no name leaks through signing; keep it that way (don't switch to a key whose material or required metadata carries a name).

## Codex sandbox

- Codex sessions for this repo commonly require `require_escalated` for commands that write git metadata or access GitHub credentials. Use escalation proactively for `git add`, `git commit`, `git switch -c`, `git push`, and GitHub CLI commands such as `gh auth status`, `gh repo view`, and `gh pr create`, because sandboxed runs cannot reliably create `.git/*.lock` files or access keyring-backed GitHub tokens.

## Dependencies

- `package.json` pins `engines.node` and uses `overrides` to force-resolve `undici`. Preserve that override when bumping deps unless you've verified the underlying advisory no longer applies.
- Dependabot is configured under `.github/dependabot.yml` — prefer letting it open PRs over manual bumps.
