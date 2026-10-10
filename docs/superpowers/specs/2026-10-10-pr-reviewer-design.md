# PR Reviewer Automático — Design (v1)

Data: 2026-10-10
Status: brainstorming aprovado (A1 TypeScript + Node 24) + revisão agnóstica rodada 2 aplicada
Objetivo: remover necessidade de humano em reviews de rotina em ambientes pró-IA com alto volume de PRs. Híbrido fast-path determinístico + slow-path LLM BYOK. Custo zero para o mantenedor.

## 1. Decisões

- Distribuição: Action JS reutilizável em TypeScript, `action.yml` com `runs.using: node24`, `main: dist/index.js`, `dist/` commitado (esbuild ou ncc), `@actions/core` + `@actions/github`, `engines.node >=24`. Sem servidor, sem DB. Tag `v1` + SHA pin.
- Alternativas descartadas: CLI Rust (build/release complexo, overkill MVP), GitHub App + servidor (precisa hosting), só workflow template (sem LLM), agente autônomo com loop (v2).
- Node 24: LTS Krypton até 2028-04, `node20` removido dos hosted runners no late-Sept 2026 (anúncio previa "later in the fall of 2026"). Verificado via docs GitHub + nodejs.org.

## 2. Fast-path (sempre, grátis, qualquer linguagem)

Três níveis, sem hardcode de linguagem:
- L0 agnóstico: diff stats, binários, arquivos grandes (>500KB avisa), paths sensíveis (`*.pem`, `id_rsa`, `.env`), segredos regex + gitleaks, TODO/FIXME/XXX, lockfile alterado sem manifest.
- L1 multi-lang: `semgrep scan --config auto --metrics=off --jobs <n>` com `<n>` resolvido em TS via `os.availableParallelism()`/`os.cpus().length` e passado como argv (`$(nproc)` só se invocado via shell) (30-40+ langs, ~10s). Diff-aware somente com token: `SEMGREP_APP_TOKEN` + `SEMGREP_BASELINE_COMMIT=$(git merge-base origin/<base> HEAD)` ou `--baseline-commit $BASE_SHA` (`SEMGREP_BASELINE_REF` está superseded; `semgrep ci` no GHA autodetecta); sem token usar `scan --baseline-commit $BASE_SHA` como fallback. Não alegar `semgrep ci` diff-aware sem token. `trivy`/`osv-scanner` para deps + SBOM opcional. SARIF para Security tab via `github/codeql-action/upload-sarif@<SHA-pinado> # v4` com `continue-on-error: true` (nunca falha o review) SOMENTE quando mesmo-repo E permissão `security-events: write` concedida E code-scanning habilitado — guard por evento: `pull_request` usa `github.event.pull_request.head.repo.full_name == github.repository`; `workflow_run` NÃO usa evento (payload tem `head_repository.full_name` no topo e elementos `pull_requests[].head.repo.full_name`, mas o array é vazio em fork) — usa `head_repo_full_name` do artifact `pr-meta.json` (`== github.repository`); senão upload como artifact + resumo no log. Nota: em repos privados sem GHAS/code-scanning, SARIF de terceiros também não aparece — documentar. CodeQL fora do PR (minutos a 30min); opcional noturno.
- L2 nativo opcional: só se config existe no repo (`cargo fmt --check`/`clippy`, `prettier --check`/`eslint`, `ruff`, `gofmt`/`go vet`). Detecção por arquivos (`Cargo.toml`, `package.json`, etc).
- Saída determinística normalizada (mesmo contrato do slow-path): `{severity: info|warning|high, file, line?, rule, message, suggestion?}`.

## 3. Slow-path (opcional, BYOK, default OpenAI-compatible)

Só roda com `llm_api_key`; sem chave pula com aviso. Diff tratado como dado não-confiável (delimitadores XML, sem execução de código do PR, sem tools para o LLM, validação de saída, log auditável). `temperature` NUNCA enviado por default em nenhum provider (família reasoning GPT-5/6/o-series aceita só default e retorna 400 para outro valor; Claude 4.7+ retorna 400 para `temperature <1`); só enviar se input explícito `llm_temperature` com allowlist por modelo.

### 3.1 Sistema multi-path/API v1 (suportado = só `openai-chat`)

- Default suportado: `POST {base_url}/chat/completions` com `{model, messages}` + `response_format` na forma exigida `{"type":"json_schema","json_schema":{"name":"pr_review","schema":{...},"strict":true}}` (`strict` interno + `name`+`schema` obrigatórios) SOMENTE onde suportado (OpenAI, Groq parcial, Mistral parcial, OpenRouter conforme modelo, Zen/Go subset `chat/completions`). Forma curta `{type: json_schema, strict: true}` é inválida e retorna 400 — não usar. Para presets Anthropic-compat omitir `response_format` e `temperature`/`top_p`/`n` (camada OpenAI-compat da Anthropic ignora `response_format` — assert `ignored`, não 400 — e retorna 400 para `temperature <1`, `top_p !=0.99`, ambos juntos ou `n !=1`; teste de 400 obrigatório só para `temperature`/`top_p`/`n`). Nesses casos: parse manual do JSON + validador com fallback para comentário geral.
- Parse: `choices[0].message.content` JSON + checar `message.refusal` SOMENTE em `openai-direct` (+ Groq/Mistral/OpenRouter/Ollama/Zen-chat onde aplicável; na camada Anthropic-compat `refusal` é sempre vazio — nunca usar como sinal) + `finish_reason`: `stop`=ok, `length`=output cortado por `max_tokens` (aumentar `max_tokens`/continuar ou degradar direto para resumo, sem retry com diff menor — truncar input não resolve corte de output), `content_filter`=pular sem retry, demais=erro tratável. Retry 1x com backoff exponencial + honra `Retry-After` SOMENTE em 5xx/429; `AbortError`/timeout (`timeout_seconds` 90, a falha mais comum) degrada para dry-run + summary sem retry.
- Inputs:
  - `llm_provider`: `openai|anthropic|google|groq|mistral|openrouter|ollama|opencode-zen|opencode-go|custom`
  - `llm_base_url`: override; vazio usa preset
  - `llm_api_style`: `auto|openai-chat|openai-responses|anthropic-messages|google-models|custom-path` (default `auto`; em v1 `auto` = `openai-chat` por provider, EXCETO quando o par `(provider,model)` consta no mapa versionado não-chat Mantido no código (ex `qwen3.8-max` Zen=`chat`, Go=`messages`) — `GET {base}/models` valida SÓ existência do id (lista `id/created/object`, sem metadado de endpoint), nunca roteia endpoint; se o par está no mapa não-chat, fail-fast com mensagem + lista suportada, sem tentar request incompatível)
  - `llm_path`: override de path APENAS (experimental, path-only, sem adapter de body; não viabiliza `/messages`, `/responses`, `/models/<n>` sozinho)
  - `llm_model`: pass-through de preço/disponibilidade (sem validação de preço); compatibilidade de endpoint é por lookup — ver `llm_api_style`.
  - `llm_api_key`, `llm_temperature`/`llm_top_p` (ambos opcionais, AMBOS omitidos por default como `temperature`; se setado validar por família: reasoning OpenAI GPT-5+/6 e Claude 4.7+ → rejeitar valor não-default com erro claro; nunca enviar `temperature` e `top_p` juntos na camada Anthropic-compat; demais → ranges permitidos), `llm_max_tokens` (default 2000; repasse por família — reasoning `o-series`/`gpt-5*`/`gpt-6*` envia `max_completion_tokens`, demais enviam `max_tokens`, nunca ambos; `max_tokens` em reasoning retorna `unsupported_parameter`), `fail_level` (`none|warning|high`, ver matriz §4), `max_diff_chars` (60000 teto) + teto por arquivo (8000), `post_comment` (`true|false` dry-run), `timeout_seconds` (90)
- Presets base (URL default + path default + notas):
  - `openai`: `https://api.openai.com/v1` + `/chat/completions`, `response_format` strict ok, `temperature` omitido por default (reasoning exige).
  - `anthropic` (camada OpenAI-compat): `https://api.anthropic.com/v1` + `/chat/completions`. Teste/não-prod segundo docs Anthropic; omitir `response_format`/`temperature`. Nativo `/messages` (body `{model, max_tokens (obrigatório), messages, system}`, headers `x-api-key`/`anthropic-version`) é v2.
  - `google`: `https://generativelanguage.googleapis.com/v1beta/openai` + `/chat/completions` (doc Gemini OpenAI-compat). Nativo v2: `POST /v1beta/models/<id>:generateContent` com `{contents, generationConfig}` via SDK Google.
  - `groq`: `https://api.groq.com/openai/v1`, `mistral`: `https://api.mistral.ai/v1`, `openrouter`: `https://openrouter.ai/api/v1` (model slug `autor/modelo`).
  - `ollama`: `http://localhost:11434/v1` + `/chat/completions`. Exige daemon no job (`services:` ou setup-step) + healthcheck `curl localhost:11434` + `ollama pull ${llm_model}` antes do slow-path (sem pull retorna 404 mesmo com daemon) + `llm_api_key: dummy` + sem `strict`.
  - `opencode-zen` (pay-per-use, `Bearer $OPENCODE_API_KEY`, `User-Agent: pr-reviewer/1.0`, catálogo `GET https://opencode.ai/zen/v1/models` valida existência do id): base `https://opencode.ai/zen/v1`. v1 SUPORTADO só `chat/completions` (`.../zen/v1/chat/completions`) — endpoint por mapa versionado `(provider,model)->api_style` no código + teste de matriz (exemplos abaixo, nunca hardcodar só por nome): inclui `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `glm-5.3-flash` (+ família `glm-5.x`), `kimi-k2.7-code` (+ `k2.6`), `kimi-k3`, `minimax-m3`/`m2.7`, `mistral-large-4`, `qwen3.8-max`, `big-pickle`, free (`space-bunny-free`, `mimo-v2.6-flash-free`, etc). GPT/Grok (`.../zen/v1/responses`), Claude/Qwen-Plus (`.../zen/v1/messages`), Gemini (`.../zen/v1/models/<n>`) exigem adapter de path E body — v1 NÃO suportado; v2 com adapters. Teste de matriz deve falhar se `GET` divergir dos exemplos.
  - `opencode-go` (assinatura $10/mês, `Bearer $OPENCODE_API_KEY`, `User-Agent: pr-reviewer/1.0` + `x-opencode-session: pr-<number>` estável, catálogo `GET https://opencode.ai/zen/go/v1/models`): base `https://opencode.ai/zen/go/v1`. Tabela PRÓPRIA em mapa versionado no código + teste de matriz (exemplos abaixo, nunca hardcodar só por nome — manter `qwen3.8-max` Zen=`chat/completions` vs Go=`messages` em entradas separadas): `chat/completions` para `glm-5.3-flash` (+ `glm-5.3`, `glm-5.2`), `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `deepseek-v4-flash` (+ `pro`, `v4.1-flash`, `vision-exp`), `mimo-v2.6-flash` (+ `v2.5`, `-pro`), `hy4-preview` (+ `hy3`, `longcat-2.0`), `space-bunny`, etc; `/responses` para `grok-4.7` (+ `4.6`), `gpt-6-luna` (+ `5.6-luna`), `muse-spark-1.3-contributor`; `/messages` para `claude-haiku-5-5`, `minimax-m3`, `minimax-m2.7`, `qwen3.8-max`, `qwen3.8-flash`. v1 SUPORTADO só o subset `chat/completions`; resto v2. Teste de matriz deve falhar se `GET` divergir. Limites por modelo (5h 20%, semana 50%, mês 100% do teto $15-60) + fallback saldo Zen opcional.
- Modelos out/2026 (exemplos — validar via `GET .../models` na implementação, nunca hardcodar preço; distinguir preço Zen vs direto). v1 (`openai-chat` apenas): `deepseek-v4.1-flash` (off-peak vs peak), `deepseek-v4-pro`, `deepseek-v4-flash`, `glm-5.3-flash` (+ família `5.x`), `kimi-k3`/`k2.7-code`/`k2.6`, `mistral-large-4`, `qwen3.8-max` (só Zen; no Go é `messages`), `minimax-m3` (só Zen; no Go é `messages`), free (`big-pickle`, `space-bunny-free`, `mimo-v2.6-flash-free`).
- v2 (adapters `responses`/`messages`/`models`): `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra`, `grok-4.7`/`4.6` (`responses`); `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `qwen3.7-max`/`plus`, `minimax-m3`/`m2.7` no Go (`messages`); `gemini-3.5-flash-lite`, `gemini-3.8-flash` (`models/<n>`).
- Orçamento: PR típico ~3k in + 600 out; TETO `max_diff_chars` 60000 ≈ 15k tokens in + overhead (custo frontier no teto ≈ $0.15-0.30/PR, não $0.001). Documentar típico vs teto e peak/off-peak. Trunca por arquivo, pula arquivos >teto com nota.

### 3.2 Skills emuladas (meta: autonomia, alto volume)

Action single-shot não comporta loop agentic/MCP pesado (LSP, LanceDB). v1 emula 3 papéis como seções do system prompt + contexto determinístico:
- `security-reviewer`, `logic-reviewer` (diff-local: null/bounds, error-handling, race, API misuse), `perf-maintainability`.
- Contexto: diff filtrado + achados fast-path + body da issue linkada (se `Fixes #n`). Sem cross-file profundo no v1 (documentado). v2: `opencode` CLI no job com skills reais.
- Limites conhecidos (qualitativo; números de benchmark variam por harness e não são garantia): LLMs bons diff-local, fracos design/authz e requisitos de negócio. Por isso `fail_level=high` só sugere `REQUEST_CHANGES` em segredo/injection/auth ausente com evidência fast-path; resto é `COMMENT`.

## 4. Dataflow

Fluxo A — job unprivileged (`pull_request` e re-disparos mesmo-repo): `pull_request(opened|synchronize|reopened|ready_for_review)` → checkout com `fetch-depth: 0` + `persist-credentials: false` + fetch explícito do `base_sha` (shallow default quebra `git diff BASE...HEAD`) → diff (`git diff -U3`, exclui lock/minified por default). Para `issue_comment`/`pull_request_review`/`workflow_dispatch` (que rodam no default branch ou sem PR checkout): resolver o número do PR por evento (`issue.number` / `github.event.pull_request.number` top-level em `pull_request_review` — `review` e `pull_request` são irmãos, `review.pull_request.number` não existe / `inputs.pr_number` via API), `git fetch origin pull/<n>/head:<tmp-pr> + fetch base_sha`, diff entre os SHAs fetcheados — nunca `HEAD` do runner → fast-path (L0+L1+L2) → sobe artifact `diff.patch` + `pr-meta.json {pr_number, head_sha, base_sha, head_repo_full_name, is_fork}` + achados fast-path → monta prompt (system + fast findings + diff truncado) → slow-path se chave (timeout 90s, retry/backoff §3.1) → valida JSON `{findings: [{severity: info|warning|high, file, line?, rule, message, suggestion?}]}` (schema `pr_review` strict onde suportado; mesmo contrato do fast-path §2) → resolve `head_sha` em runtime via API (re-resolve em 422) → mapeia `line` para hunk (só linhas do diff; fora do diff vira item geral) → 1 review consolidado.
Fluxo B — job privilegiado `workflow_run` (só fork com App token): SÓ `download-artifact` + valida JSON do artifact + resolve `head_sha` + POSTA. NUNCA `checkout`, `semgrep`, L2 ou slow-path com código do PR (ver §5).
Matriz `fail_level`→`event`: `none`=sempre `COMMENT` sem afetar exit code (só log); `warning`=`COMMENT` + exit code distinto sem bloquear merge (nunca `REQUEST_CHANGES`); `high`=`REQUEST_CHANGES` só se achado `high` com evidência, senão `COMMENT`; nunca `APPROVE` automático em v1; `post_comment: false`=dry-run só em logs. `body` obrigatório em `REQUEST_CHANGES`/`COMMENT`.
Force-push = nova execução; reviews antigas permanecem como outdated, nova execução usa novo `commit_id` (version alignment).
Concorrência explícita: unprivileged `group: pr-reviewer-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr_number }}` com `cancel-in-progress: true`; job privilegiado `workflow_run` com grupo `pr-reviewer-priv-${{ github.event.workflow_run.head_repository.full_name }}-${{ github.event.workflow_run.head_branch }}` (nunca `pull_requests[0].number`, vazio em fork), `cancel-in-progress: true`, trigger `types: [completed]` + guard `if: ${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request' }}` (sem filtro, run cancelado/falho dispara POST de review superado ou `download-artifact` inexistente), `run-id: ${{ github.event.workflow_run.id }}`, download em `path: ${{ runner.temp }}/artifacts`.

## 5. Postagem real (não só CI)

`POST /repos/{owner}/{repo}/pulls/{number}/reviews` com `{commit_id, body, event: COMMENT|REQUEST_CHANGES, comments: [{path, line, side, body}]}` + par `start_line+start_side` junto de `line+side` sempre juntos em multi-line por corretude (não por 422 alegado). `side` computado do hunk: deleção (`-`) → `LEFT`, adição (`+`)/contexto → `RIGHT`. Preferir `line+side`; `position` como alternativa válida legada, nunca em escrita nova. 422 esperado em line-fora-do-diff/commit-stale → fallback para item geral + re-resolve `head_sha`. Sem file-level multi (não suportado). Fallback `/issues/{n}/comments` SOMENTE quando habilitado E com `issues: write`; em fork read-only nem issue comment nem check nem SARIF funcionam — só logs/summary + artifact.
Triggers com guards por evento (paths diferentes): `pull_request`; `pull_request_review[submitted]` com `github.event.review.body` + check `author_association`; `issue_comment[created]` SOMENTE se `github.event.issue.pull_request` existe (só PR, não issue pura) E `github.event.comment.body` contém `/review` E `author_association` em (OWNER,MEMBER,COLLABORATOR); `workflow_dispatch{pr_number: required}`. `issue_comment` roda no default branch; `pull_request_review` em fork também é read-only (mesmo gate App-token).
Permissões mínimas default: `contents: read, pull-requests: write` (+ `issues: write` SOMENTE quando fallback issue-comment habilitado; + `security-events: write` SÓ no job SARIF condicional). Job privilegiado `workflow_run`: `contents: read, pull-requests: write, actions: read` (+ `issues: write`/`security-events: write` nas mesmas condições). `checks: write` SÓ se criar check-runs (fora do default). `persist-credentials: false`, pin SHA, sem interpolação de título/body em `run:`, sem `pull_request_target` em público. Forks: `GITHUB_TOKEN` read-only → sem POST (só logs/summary + artifact); review completo exige App token via padrão two-workflow com segregação rígida — job unprivileged (`pull_request`) faz checkout (`fetch-depth: 0`)+diff+fast-path e sobe artifact do diff; job privilegiado (`workflow_run`, `types: [completed]`) faz SÓ `download-artifact` (`run-id: ${{ github.event.workflow_run.id }}`, `path: ${{ runner.temp }}/artifacts`), reutiliza `achados fast-path` + `diff.patch` do artifact SEM re-executar L1/L2 (L2 nativo sem checkout é impossível; com checkout de fork em job com App token é RCE), NUNCA `checkout` do head do fork, e só valida JSON + resolve `head_sha` + POSTA (nunca executa código do PR), ex `actions/create-github-app-token`.

## 6. Segurança LLM

Prompt injection é LLM01 OWASP. Sem números de taxa como garantia (dependem de harness). Defesas: separação estrutural (XML), allowlist (nenhuma tool para o LLM), validação de saída contra permissões, log de cada chamada. Nunca vazar `llm_api_key` em logs.

## 7. Testes e distribuição

- Unit (vitest): diff parser, truncamento, mapeamento line→hunk com LEFT/RIGHT (+par start), matriz presets Zen/Go, gate `response_format`/`temperature` por provider (inclui shape `name+schema+strict` e teste 400 Anthropic/reasoning), validador JSON, redact secrets.
- Integração: `uses: ./` com `node --check dist/`, matriz ubuntu/macos/windows, `pre/main/post` paths, fork simulado sem secret (assert sem POST), SARIF condicional, ollama pull+healthcheck, guards de trigger, grupo de concorrência.
- E2E manual: repo demo com PRs sintéticos (segredo, SQLi, race, diff gigante, force-push, linha deletada, multi-line).
- Release: tag imutável + `v1` móvel após canário, marketplace.

## 8. Template usuário final

`docs/workflow-template.yml` + README com presets, matriz Zen/Go suportada v1, custos típico vs teto (Zen vs direto, peak/off-peak), fork/App token two-workflow com segregação, `post_comment: false` dry-run.

## Escopo v1 vs v2

v1: acima (só `openai-chat` suportado; `llm_path` path-only experimental). v2: adapters Responses/Messages/Google nativos, matriz por-família completa, retrieval cross-file (code graph), MCP (Jira/Sentry), fix suggestions auto-commit, dashboard FP.

## 9. Adapters v2 (escopo aprovado 2026-10-10 — só adapters, resto do v2 fica para depois)

Objetivo: `llm_api_style` explícito e `auto` passam a suportar todos os endpoints Zen/Go, sem mudar nada do fast-path, postagem ou fluxos. Mesmo contrato de saída: `{findings: [{severity, file, line?, rule, message, suggestion?}]}` + mesmo `LlmResult` (`ok/timeout/content-filter/invalid-json/http-error/unsupported`).

### 9.1 `openai-responses` — POST `{base}/responses`
- Request: `{model, input: [{role:"system",content},{role:"user",content}], max_output_tokens?, temperature? (omitido por default, mesmas regras validateSampling)}`. Structured output: `text: {format: {type:"json_schema",name:"pr_review",schema,strict:true}}` onde suportado (OpenAI Responses); se 400 → retry sem format + parse manual.
- Response: junta `output[].content[]` com `type:"output_text"` (ou `text`) → string JSON → mesmo parse/validação do chat. `refusal` em item → trata como refusal. `incomplete` (max tokens) → equivale a `length`: degradar para resumo.
- Modelos: GPT/Grok/Muse-Spark via Zen (`.../zen/v1/responses`), Go (`.../zen/go/v1/responses`): `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra`, `grok-4.7/4.6`, `muse-spark-1.3-contributor(-free)`, etc.
- Auth: `Authorization: Bearer` + `User-Agent: pr-reviewer/1.0` (+ `x-opencode-session` no Go).

### 9.2 `anthropic-messages` — POST `{base}/messages`
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json` (+ `User-Agent`, + `x-opencode-session` no Go).
- Request: `{model, max_tokens (OBRIGATÓRIO, de llm_max_tokens), system, messages: [{role:"user",content}]}`. NUNCA `temperature`/`top_p`/`n`/`response_format` por default (regras validateSampling existentes: Claude 4.7+ rejeita).
- Response: concatena `content[]` com `type:"text"` → parse manual + validador. `stop_reason`: `end_turn`=ok, `max_tokens`=degradar, `refusal` → pular (campo sempre vazio na camada compat — usa nativo aqui, checar de verdade).
- Modelos: Claude (Opus/Sonnet/Haiku/Fable) + Qwen-Plus/Flash + MiniMax no Go via `.../messages`.

### 9.3 `google-models` — POST `{base}/v1beta/models/<id>:generateContent`
- Para Zen (`.../zen/v1/models/<id>`): segue o path do catálogo com a mesma semântica (adapter detecta `/models/` no endpoint e usa corpo Google).
- Request: `{contents: [{role:"user",parts:[{text}]}], systemInstruction: {parts:[{text}]}, generationConfig: {responseMimeType:"application/json", responseSchema:<schema>, maxOutputTokens}}`. Sem `responseSchema` se 400 → retry sem + parse.
- Response: `candidates[0].content.parts[]` text → parse. `finishReason`: `STOP`=ok, `MAX_TOKENS`=degradar, `SAFETY`/outros=pular sem retry.
- Auth: `key` via query `?key=` OU header `x-goog-api-key` (preferir header; nunca logar).

### 9.4 Regras transversais (valem para os 3 adapters)
- `temperature`/`top_p` NUNCA por default; `validateSampling` estendido com `apiStyle` (já existe o parâmetro).
- `max_tokens` mapping: reasoning OpenAI → `max_completion_tokens` (chat) / `max_output_tokens` (responses); Anthropic → `max_tokens` (obrigatório); Google → `maxOutputTokens`.
- Timeout 90s (AbortController cobrindo body), retry 1x só 5xx/429 com backoff + Retry-After; `llm_api_key` nunca em logs (redact/scrub existentes).
- `auto`: consulta o mapa versionado `(provider,model)`; pares non-chat agora RESOLVEM para seu adapter em vez de fail-fast. `GET {base}/models` continua validando só existência.
- `llm_path` custom continua path-only experimental (sem adapter inferido).
- Testes: matriz por adapter (request shape exato + response parse + refusal/finish de cada protocolo + 400-fallback), sem chamadas reais (fetch mockado).
