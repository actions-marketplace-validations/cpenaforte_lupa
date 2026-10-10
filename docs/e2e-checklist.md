# End-to-end checklist

Manual checks against a disposable consumer repository, run on the **canary** commit before any
floating tag moves. Each case lists the PR to create and the assertions to verify. The unit tests
cover the mapping logic (`eventFor`, `exitFor`, `buildBody`); these cases cover the wiring in a real
GitHub run.

Setup: a private test repository with the workflow from `docs/workflow-template.yml` pointing at the
canary SHA, `vars.PR_REVIEWER_MODEL` and `secrets.LLM_API_KEY` set, and `fail_level: warning`
unless a case says otherwise. Read the review body on the PR, the job summary, and the
`pr-reviewer-out` artifact.

Every case asserts, in addition to its own rows:

- the artifact `pr-reviewer-out` contains `diff.patch`, `pr-meta.json`, `findings.json`, `sarif.json`, `sbom.cdx.json` (where the scanner ran);
- the LLM key value never appears in the job log, the summary, the review body, or any artifact;
- the workflow exit code matches the `exit-code` output (`0` pass, `2` warning, `1` high).

## Cases

| # | Synthetic PR | Expected event | Expected body / findings | Expected exit |
|---|---|---|---|---|
| 1 | **Secret leak**: adds `const KEY = "AKIA…"` (a fake AWS-shaped key) to `src/config.ts` | `COMMENT` (`fail_level: warning`); `REQUEST_CHANGES` only with `fail_level: high` | gitleaks finding anchored to `src/config.ts:<line>`; the secret value is **not** repeated in the body | `2` (warning) or `1` (`high`) |
| 2 | **SQL injection**: `db.query("SELECT * FROM u WHERE id=" + req.query.id)` added in a route | `COMMENT` (`warning`) | LLM finding inline on the added line; no finding on untouched lines | `2` |
| 3 | **Race**: unsynchronised shared counter updated from two async handlers | `COMMENT` | LLM finding that cites the shared variable; severity may be `warning` (not asserted to be `high`) | `2` |
| 4 | **Giant diff**: >60 000 changed characters across many files | `COMMENT` | Review still posted. Body/summary notes truncation; `diff.patch` in the artifact is untruncated; the prompt input is capped (`max_diff_chars`) | per findings |
| 5 | **Force-push**: push a rewritten history to an open PR branch | `COMMENT` for the new head SHA (`synchronize` event) | Review refers to the new head SHA only; no stale findings from the old head | per findings |
| 6 | **Deleted line**: removes a line that had a finding on the previous head | `COMMENT` | No inline comment on the deleted line (not on the new head's diff); no error | per findings |
| 7 | **Multi-line finding**: LLM reports a range across five added lines | `COMMENT` | Inline comment anchored to a valid added line inside the range; no 422 from the API | per findings |
| 8 | **Fork PR, secrets not granted** (`pull_request` from a fork) | `COMMENT` not posted (read-only token): summary and artifact only | Warning `review not posted; summary and artifact only`; L2 toolchains skipped (`fork PR with secrets in scope`) when secrets are in scope | per findings, no POST |
| 9 | **`/review` retrigger** (`issue_comment` `created` containing `/review`, author `OWNER`/`MEMBER`/`COLLABORATOR`) on a PR | `COMMENT` for the current head | Review posted once; the same comment from an external author (`CONTRIBUTOR`/`NONE`) triggers nothing | per findings |

Negative controls (run once each):

- `/review` from an external author → no job runs a review, no comment is posted.
- `issue_comment` on a plain issue (no PR) → the job is skipped by the `if:` guard.
- `fail_level: none` on case 1 → exit `0`, review still posted with the warning.

## Local smoke (no LLM, no network beyond the GitHub API)

```bash
npm ci
npx vitest run
npm run build
node --check dist/index.js
test -s dist/index.js
git diff --exit-code -- dist/index.js
```

## Release procedure

Digests and pins must already be real before release. Verify:

```bash
grep -E '^export const (TRIVY|OSV|GITLEAKS)_DIGEST = "sha256:[0-9a-f]{64}";' src/scanners.ts | wc -l   # must print 3
grep -n '0000000000000000000000000000000000000000' docs/workflow-template*.yml   # placeholder, replaced in step 4
```

1. **Release commit R** on `main`: CI green (`build`, `smoke`, `fork-sim`, `ollama`, `guards`), `dist/index.js` in sync with the build, `action.yml` complete (see step 5 about branding).
2. **Immutable tag.** Create an annotated tag on R and push it. The tag is never moved:

   ```bash
   git tag -a v0.1.0 -m "pr-reviewer v0.1.0" R
   git push origin v0.1.0
   SHA=$(git rev-parse "v0.1.0^{commit}")
   echo "$SHA"   # 40 hex; this is the pin consumers use
   ```

3. **Canary.** In the consumer test repository, point the workflow at `OWNER/pr-reviewer@$SHA` and run every case above. All must pass. If anything fails, fix on `main`, cut a new tag (`v0.1.1`), and repeat. Do not touch `v0.1.0` or `v1`.
4. **Substitute the template placeholder** (after canary passes; this is a follow-up commit, not R). The placeholder is the exact string `OWNER/pr-reviewer@0000000000000000000000000000000000000000` in `docs/workflow-template.yml` and `docs/workflow-template-privileged.yml`. Replace the owner and the SHA together. `OWNER` is the GitHub owner that publishes the action (`OWNER=your-login`, not a literal):

   ```bash
   OWNER=your-login
   sed -i "s#OWNER/pr-reviewer@0000000000000000000000000000000000000000#$OWNER/pr-reviewer@$SHA#" docs/workflow-template.yml docs/workflow-template-privileged.yml
   grep -n "$SHA" docs/workflow-template.yml docs/workflow-template-privileged.yml   # both files
   npx vitest run tests/templates.test.ts
   git add docs/workflow-template.yml docs/workflow-template-privileged.yml
   git commit -m "docs: pin templates to v0.1.0 ($SHA)"
   ```

   Never type a SHA by hand. Use the value printed by `git rev-parse` in step 2.
5. **Floating major tag `v1`**, only after the canary is green. Move it to the same commit as `v0.1.0`:

   ```bash
   git tag -f v1 "v0.1.0^{commit}"
   git push --force origin v1
   ```

6. **Marketplace.** On the GitHub release for `v0.1.0`, tick "Publish this Action to the GitHub Marketplace" and check the listing copy against `action.yml` (`name: "PR Reviewer"`, the `description` field, the inputs and outputs). The Marketplace also requires a `branding:` block (`icon`, `color`) in `action.yml`. It must be in R before tagging. Missing branding blocks publication.
