# CLAUDE.md

Coding guidance for this repo. Extracts the rules a contributor (human or agent) needs to write code that passes CI and runs in production. README.md remains the source of truth for setup, secrets, and operations.

## Stack

- TypeScript with native ES2024 modules. **No build step** — runtime is `node --import tsx index.ts`. Don't add `tsc` emit, a `dist/` directory, or a bundler.
- Node `>=22.12 <27` (`.nvmrc` pins 22.12.0; image is `node:24` builder + `gcr.io/distroless/nodejs24:nonroot` runtime).
- discord.js v14, Express v5 (healthcheck only), Winston, axios, ws, node-schedule.
- Vitest for tests. `npm run typecheck` checks the production config and the test config — there is no separate compile.

## Code conventions

- Relative imports use the `.js` extension even from `.ts` files. Vitest and NodeNext resolve those imports to TypeScript sources during tests. Example: `import {x} from "./foo.js";`. Imports without `.js` will fail at runtime.
- Airbnb style, 2-space indent, double quotes — match the surrounding file.
- One feature per module under `modules/<feature>.ts`, with `<feature>.test.ts` alongside. `index.ts` only wires startup; feature logic does not belong there.
- Keep modules under ~800 lines. Split before adding more.
- Don't introduce code that requires a shell, package manager, or writable filesystem at runtime — the production image is distroless, nonroot, read-only. Writes only go to `/dev/shm` (set as `TMPDIR`).

## Tests, types, and coverage

- `npm run test:coverage` and `npm run typecheck` must both pass. CI runs them on every PR.
- `vitest.config.ts` enforces global thresholds (75/75/65/58 stmt/lines/funcs/branches) and stricter per-module thresholds for several modules in `modules/` (90–100% in some). Don't lower a threshold to make a change pass — write the test, or split the module.
- Tests use `*.test.ts` next to the source file; `modules/test-utils/` is excluded from coverage.

## Configuration & secrets

- Local dev reads `config.json` at the repo root. It contains secrets — gitignored, never log it, never paste contents into commits, PRs, or external tools.
- Production reads Docker secrets prefixed by environment: `production_*` or `staging_*`. Resolution is environment-scoped — exactly one prefix is mounted, selected by the `environment` secret. Mounting both, or neither, is a startup error. Don't add code paths that read both prefixes or fall back across them.
- `HEALTHCHECK_PORT` (default 11312) and `LOGLEVEL` are the env-var overrides recognised by the bot. `healthcheck.js` calls `/api/v1/health`; keep that endpoint working when touching the HTTP server.

## CI/CD invariants

- `main` is the released branch. All work goes via feature branches and PRs.
- The CI pipeline runs: tests + typecheck → Dockerfile validator + Checkov + Sysdig CIS benchmark → image build/push to `ghcr.io` → Trivy scan (HIGH/CRITICAL, fixed only) → cosign sign → webhook redeploy by image digest. Staging must report `/api/v1/ready` before production rolls.
- Separate workflows run CodeQL, njsscan, and Semgrep. Treat their findings as blocking.
- Don't loosen any of: `coverageThreshold`, `npm audit --audit-level=high`, Trivy severity filters, Checkov framework scope, image signing, or the staging readiness gate. If one is genuinely the wrong fit, raise it explicitly rather than editing it through.

## Dependencies

- `package.json` pins `engines.node` and uses `overrides` to force-resolve `undici`. Preserve that override when bumping deps unless you've verified the underlying advisory no longer applies.
- Dependabot is configured under `.github/dependabot.yml` — prefer letting it open PRs over manual bumps.
