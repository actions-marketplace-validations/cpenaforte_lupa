# PR Reviewer

A reusable GitHub Action (TypeScript, Node 24) that reviews pull requests in two layers and posts the result as one review:

- **Fast-path (always, free, any language):** diff statistics, sensitive paths, secret patterns (regex + gitleaks), TODO/FIXME markers, lockfile changes without a manifest, and scanners (semgrep, trivy, osv-scanner). Optional L2 native toolchains run only when the repository already has their config.
- **Slow-path (optional, bring your own key):** an LLM reviews the diff. It runs only when `llm_api_key` is set. Without a key it is skipped with a warning and the fast-path result is posted.

The diff is treated as untrusted data. The LLM has no tools and its output is validated against a schema before anything is posted.

## Quick start

1. Pin the action to a released commit SHA (never a branch) and copy a template into your repository:

   ```bash
   mkdir -p .github/workflows
   cp docs/workflow-template.yml .github/workflows/pr-reviewer.yml
   ```

   Replace `OWNER` and the all-zero SHA in the template with a released `pr-reviewer` commit.

2. Add secrets and variables to the repository:

   | Name | Kind | Purpose |
   |---|---|---|
   | `LLM_API_KEY` | secret | Key for the LLM provider. Omit it to run fast-path only. |
   | `PR_REVIEWER_MODEL` | variable | Model name, for example `deepseek-v4-flash` on `opencode-go`. |
   | `PR_REVIEWER_APP_ID` / `PR_REVIEWER_APP_KEY` | variable / secret | Only for fork PRs with the privileged template (see below). |

3. Open a pull request. The review is posted for `opened`, `synchronize`, `reopened` and `ready_for_review`. You can also comment `/review` on a PR (trusted author associations only) or run `workflow_dispatch` with `pr_number`.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `github_token` | `${{ github.token }}` | Reads the diff and posts the review. |
| `llm_provider` | `openai` | `openai`, `anthropic`, `google`, `groq`, `mistral`, `openrouter`, `ollama`, `opencode-zen`, `opencode-go`, `custom`. |
| `llm_base_url` | (preset) | Overrides the preset base URL. Required for `custom`. |
| `llm_api_style` | `auto` | `auto`, `openai-chat`, `openai-responses`, `anthropic-messages`, `google-models`, `custom-path`. See API styles below. |
| `llm_path` | (preset) | Path override only (experimental, path-only). Query strings and fragments are dropped with a warning. |
| `llm_model` | (empty) | Model name, passed through as is. |
| `llm_api_key` | (empty) | Provider key. Never logged. |
| `llm_temperature`, `llm_top_p` | (unset) | Sent only when set explicitly. Left unset by default because reasoning models reject other values. |
| `llm_max_tokens` | `2000` | Maximum output tokens. |
| `pr_number` | (empty) | Used only by `workflow_dispatch`. |
| `fail_level` | `warning` | `none`, `warning` or `high`. See the gate section. |
| `max_diff_chars` | `60000` | Diff ceiling sent to the LLM. |
| `post_comment` | `true` | `false` makes a dry-run. |
| `timeout_seconds` | `90` | LLM request timeout. A timeout degrades to a summary without retry. |

Output: `exit-code` (`0` pass, `2` warning findings, `1` high-severity findings).

## Providers

v1 supports the `openai-chat` API style only: `POST {base_url}/chat/completions` with the JSON-schema `response_format` where the provider accepts it. Anthropic-compatible presets omit `response_format`, `temperature`, `top_p` and `n`, and the output is parsed manually.

| `llm_provider` | Base URL (preset) | v1 status |
|---|---|---|
| `openai` | `https://api.openai.com/v1` | v1: `openai-chat`. Reasoning models (GPT-5/6, o-series) take their own token field and only the default temperature. |
| `anthropic` | `https://api.anthropic.com/v1` | v1: OpenAI-compatible layer only. Testing and non-production use; native `/messages` is v2. |
| `google` | `https://generativelanguage.googleapis.com/v1beta/openai` | v1: OpenAI-compatible layer. Native `models/<id>:generateContent` is v2. |
| `groq` | `https://api.groq.com/openai/v1` | v1 |
| `mistral` | `https://api.mistral.ai/v1` | v1 |
| `openrouter` | `https://openrouter.ai/api/v1` | v1. Model slugs look like `author/model`. |
| `ollama` | `http://localhost:11434/v1` | v1. Needs a daemon in the job (`services:` or a setup step), a healthcheck, `ollama pull <model>` before the run, `llm_api_key: dummy`, and no strict schema. |
| `opencode-zen` | `https://opencode.ai/zen/v1` | v1 subset: chat-capable models only. |
| `opencode-go` | `https://opencode.ai/zen/go/v1` | v1 subset: chat-capable models only. |
| `custom` | (you set `llm_base_url`) | v1, OpenAI-compatible. |

### opencode-zen and opencode-go

- **Key:** `Bearer` with your OpenCode API key (`OPENCODE_API_KEY` in your own tooling, `LLM_API_KEY` in this action).
- **Headers:** the action sends `User-Agent: pr-reviewer/1.0`. `opencode-go` also sends `x-opencode-session: pr-<number>`, stable per PR, so the provider can group the calls.
- **Model check:** the action calls `GET {base}/models` to confirm the model id exists. It checks the id only and never changes the endpoint.
- **Routing table:** the action keeps a versioned map of `(provider, model) → API style` in code. Some models are not served by chat completions. Examples: `claude-*`, `minimax-m3`, `minimax-m2.7`, `qwen3.8-max` and `qwen3.7-*` on Go use `anthropic-messages`; `grok-*`, `gpt-6*` and `gpt-5.6-luna` use `openai-responses`; `gemini-*` use `google-models`. The same model can differ by provider: `qwen3.8-max` is chat-capable on Zen but `anthropic-messages` on Go. For non-chat pairs the action fails fast with a clear message instead of sending an incompatible request. Non-chat styles are v2.
- **Go limits (operator reference):** a 5-hour window of 20%, a weekly limit of 50%, a monthly limit of 100%, and per-model caps of $15 to $60. When a Go subscription limit is hit, the provider falls back to the Zen balance. The action does not switch providers itself.

### API styles

- `auto` resolves to `openai-chat` in v1, except for pairs in the non-chat map, which fail fast.
- `openai-responses`, `anthropic-messages` and `google-models` are v2. Selecting them in v1 fails with an explicit error.
- `custom-path` requires `llm_path`. A path-only override that names a non-chat endpoint (`/messages`, `/responses`, `/models`) is rejected, because a body adapter is required.

## Cost

Budget figures are estimates. Prices change: check your provider's price page, and compare **Zen vs direto** (calling the model provider directly with its own key). Zen is pay-per-use through OpenCode, and its prices can differ from the direct provider prices.

- **Cost of a typical PR:** about 3k input tokens plus 600 output tokens.
- **Ceiling:** `max_diff_chars` 60000 is about 15k input tokens plus prompt overhead. At frontier-model prices that is roughly $0.15 to $0.30 per PR at the ceiling, not $0.001. Lower `max_diff_chars` to cap spend. Files larger than the per-file cap (8000 characters) are truncated, and files over the total ceiling are skipped with a note.
- **peak/off-peak pricing:** some models price by time of day. For example, `deepseek-v4.1-flash` has different peak and off-peak prices. Check the current rates before choosing a model for high-volume repositories.
- **Retries:** one retry with exponential backoff, only on 5xx and 429 (honouring `Retry-After`). Timeouts and output truncation (`finish_reason: length`) are not retried with a smaller diff, because truncating the input does not fix truncated output.

## Gate: `fail_level`

The findings and the gate are separate. The review event and the exit code follow the level:

| `fail_level` | Review event | Exit code |
|---|---|---|
| `none` | always `COMMENT` | `0` always (log only) |
| `warning` | `COMMENT` | `2` if any finding is `warning` or `high`; `0` for info-only |
| `high` | `REQUEST_CHANGES` only when a `high` finding has evidence; otherwise `COMMENT` | `1` if any `high` finding; `0` otherwise |

- The action never approves automatically in v1.
- A `REQUEST_CHANGES` review always has a body.
- The action step exits non-zero for `1` and `2`, so the template runs it with `continue-on-error: true` and reads `steps.review.outputs.exit-code` in a separate gate step.
- The template's gate passes on `0` and `2` and fails on `1`. With `fail_level: warning` nothing blocks the merge, because high findings still produce exit `2`. Set `fail_level: high` to block on high-severity findings.

## Dry-run: `post_comment: false`

With `post_comment: false` the action runs the whole pipeline, writes the summary and the artifact, and logs the review it would have posted. Nothing is posted to the PR. Use it to tune the prompt, the model, or `max_diff_chars` before you enable posting.

## Forks and the two-workflow setup

A fork PR gets a read-only `GITHUB_TOKEN`, so the review cannot be posted from the PR workflow. In that case the action writes the summary and uploads the review artifact (`pr-reviewer-out`, containing `diff.patch`, `pr-meta.json`, `findings.json`, `sarif.json` and `sbom.cdx.json`). Issue comments and code-scanning uploads do not work on read-only fork runs either.

To post reviews on fork PRs, use the two-workflow pattern with an App token:

1. **Unprivileged** (`docs/workflow-template.yml`, trigger `pull_request`): checks out the PR head with `persist-credentials: false`, writes the diff against the fetched base SHA, runs the review and uploads the artifact. It holds no App key.
2. **Privileged** (`docs/workflow-template-privileged.yml`, trigger `workflow_run` on `PR Reviewer` with `types: [completed]`, guarded to successful `pull_request` runs): runs in the base repository context. It only downloads the artifact by `run-id`, verifies the files, and posts the review, using a GitHub App token created with `actions/create-github-app-token` when `PR_REVIEWER_APP_ID` is set. It never checks out PR code, never runs scanners or L2, and never calls the LLM.

The segregation matters: the privileged job reads only the artifact, so PR code never runs with the App key.

**Fork L2 skip:** on fork PRs with secrets in scope (any trigger other than `pull_request`, a writable App token, or an `llm_api_key`), the action does not run L2 native toolchains, because they execute repository-defined tooling. Semgrep, gitleaks and trivy still run. A warning is logged.

**Known limitation:** every scanner and L2 process gets a scrubbed environment (no `*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`, `*AUTH*`, `GITHUB_TOKEN` or `ACTIONS_*` variables). This is not a sandbox. A residual `/proc` vector remains: a process can read its parent's environment and memory maps. For high-threat repositories, move the review of untrusted code into a workflow with no secrets and no base-repository context, and post results only through the privileged template.

## Security notes

- Keep `permissions` minimal: `contents: read`, `pull-requests: write`. Add `issues: write` only with the issue-comment fallback (`PR_REVIEWER_ISSUE_FALLBACK: "true"`), and `security-events: write` only for the SARIF upload.
- Pin the action and every third-party action to a commit SHA.
- Never interpolate PR titles or bodies into `run:` steps. `pull_request_target` is not used.
- `llm_api_key` is never written to logs. Prompt-injection defences are structural (delimited diff, no tools for the model, output validation, an auditable log of each call). They are not a guarantee.
- The model can be wrong. Treat findings as suggestions and keep human review for security-critical changes.
