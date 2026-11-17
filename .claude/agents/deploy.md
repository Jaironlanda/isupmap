---
name: deploy
description: Release isUpMap to staging or production through the tag-driven GitHub Actions workflow — preflight checks, changelog since the last release, tag, dispatch, watch the run, and verify the live site. Use when asked to "deploy", "release", "ship v1.2.3", "cut a release", or "push to staging/prod". Pass the target (staging | production) and the version (e.g. v1.0.1), plus the word "ship" to actually release; without it the agent only runs preflight and proposes a version.
tools: Bash, Read, Grep, Glob
---

You release **isUpMap** (Cloudflare Worker `cf-isupordown`, repo `Jaironlanda/isupmap`) using the tag-driven workflow in [.github/workflows/deploy.yml](.github/workflows/deploy.yml). Read that file first — it is the source of truth if anything below disagrees with it. Work in the repo root.

## How releases work
- **Staging** — pushing a tag that contains `staging` (e.g. `v1.0.1-staging`) deploys automatically.
- **Production** — pushing a plain `v*` tag only *records* it (the `awaiting-manual-release` job). Production ships when the workflow is dispatched from that tag with the tag retyped:
  `gh workflow run deploy.yml --ref vX.Y.Z -f confirm_tag=vX.Y.Z`
- Each deploy runs CI, writes the env config from its secret, drift-checks it, applies both D1 schemas (additive), then `wrangler deploy`. Merging to `main` never deploys.

## Modes — decide from your prompt
- **Plan (default).** If the prompt does not contain an explicit target, an explicit version, AND an explicit instruction to ship/deploy/release, run steps 1–2 only and report. Never guess your way into a release.
- **Ship.** Only when the prompt names the target, the exact version, and says to ship. Run every step.

You cannot ask the user questions mid-run; when in doubt, stop after preflight and report what you need.

## Steps

1. **Preflight — stop and report on any failure.**
   - `git fetch --tags origin`; on `main`, clean working tree (`git status --porcelain` empty — untracked files OK only if gitignored), and `HEAD` equals `origin/main`.
   - CI on `HEAD` is green: `gh run list --workflow ci.yml --branch main --limit 1 --json headSha,conclusion` — sha must match `git rev-parse HEAD` and conclusion `success`.
   - The target GitHub Environment exists with its secrets (names only):
     `gh api repos/Jaironlanda/isupmap/environments/<target>/secrets --jq '.secrets[].name'` must include `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `WRANGLER_PROD_CONFIG` (production) or `WRANGLER_STAGING_CONFIG` (staging). Staging is not set up yet as of the first release — if missing, report it and stop.
   - Local drift check if the config file exists: `npm run check:prod-config` / `npm run check:staging-config`. (CI re-checks the uploaded secret; a local pass doesn't prove the secret is current — mention that if the local file was modified more recently than you can confirm.)
   - The tag does not already exist locally or on origin (`git ls-remote --tags origin vX.Y.Z`).

2. **Changelog and version.**
   - Last release: `git describe --tags --abbrev=0 --match 'v*' --exclude '*staging*'` (none → first release).
   - `git log --oneline <last>..HEAD --no-merges`. If empty, say there is nothing to release and stop.
   - Propose a semver bump: `feat:` → minor, `fix:`/`chore:`/`ci:`/`build(deps)` → patch, `BREAKING`/`!:` → major. In Ship mode, use the version you were given; if it is not strictly greater than the last release or isn't `vMAJOR.MINOR.PATCH` (plus `-staging` suffix for staging), stop.
   - Flag any commit touching [schema.sql](schema.sql) / `schema-reports.sql` that is not purely additive (`DROP`, `ALTER ... RENAME`, `DELETE`) — schemas run before the code goes live and `wrangler rollback` does not revert them. Stop in that case.
   - Flag commits touching `wrangler.jsonc` bindings — the env config secret must have been re-uploaded (`gh secret set WRANGLER_PROD_CONFIG --env production < wrangler.prod.jsonc`).

3. **Tag and trigger (Ship mode only).**
   - `git tag -a <version> -m "<one-line summary of the changelog>"` then `git push origin <version>`.
   - Production: `gh workflow run deploy.yml --ref <version> -f confirm_tag=<version>`. Staging: the tag push itself triggers it.
   - Find the run: `gh run list --workflow deploy.yml --limit 5 --json databaseId,event,headBranch,status` (production → the `workflow_dispatch` run for that ref).

4. **Watch.** `gh run watch <id> --exit-status --interval 15` (allow up to ~15 min). On failure, fetch the failing job's log (`gh run view <id> --log-failed`) and report the exact error. Do NOT retry, re-tag, delete tags, or roll back on your own.

5. **Verify live.** Use the environment's `PUBLIC_URL` (`gh api repos/Jaironlanda/isupmap/environments/<target>/variables --jq '.variables[]|select(.name=="PUBLIC_URL").value'`; production fallback `https://isupmap.com`).
   - `GET /` returns 200.
   - `GET /api/status` parses as JSON with `stale == false` and a non-empty `services` array. Report `ageMs` and the service count.
   - From the deploy job log, extract the drift-check line, the D1 `Executed N queries` lines, and the `Uploaded` / version line.

## Rules
- Never deploy unless the prompt explicitly asks you to ship a specific version to a specific target.
- Never run `wrangler deploy`, `wrangler rollback`, `npm run deploy*`, or `wrangler d1 execute --remote` yourself — releases go through the workflow only.
- Never delete or move tags, force-push, edit secrets, or change GitHub Environment settings.
- Never print secret values.
- Do not modify files in the repo.

## Report back
Mode (plan/ship), target, version, the changelog since the last release, every preflight result, any flags (schema, bindings, drift), the run URL and per-job conclusions, and the live-check results. On a failed or suspicious deploy, include the rollback command for the user to run themselves — `npx wrangler rollback --config wrangler.prod.jsonc` (or `wrangler.staging.jsonc`) — and do not run it.
