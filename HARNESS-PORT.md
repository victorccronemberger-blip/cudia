# Harness construction ported into opencode

Your Pulsaniurwo Harness construction, applied to opencode **through its native config/agent seams — no core fork**. Nothing in `packages/**` was modified, so opencode stays upgradeable.

Files added (all under `.opencode/`, alongside opencode's own untouched `opencode.jsonc`):

- `.opencode/opencode.json` — your 7 providers, models, reasoning wiring, default model/agent, and compaction tuning.
- `.opencode/agent/harness.md` — your cyber-ops system prompt (the default agent).
- `.opencode/agent/compaction.md` — your continuity-brief discipline layered on opencode's summary compaction.

## What maps to what

| Sua construção (Harness) | Onde vive agora no opencode |
|---|---|
| System prompt cyber-ops | `.opencode/agent/harness.md` (o `prompt` do agente substitui o prompt nativo do provedor) |
| DeepSeek / Z.ai-GLM / Qwen / Kimi / InferX / TokenRouter / NVIDIA-NIM + baseURLs | `provider.*` com `npm: @ai-sdk/openai-compatible` + `options.baseURL` |
| `reasoningField: reasoning_content` | `models.*.interleaved: { field: "reasoning_content" }` (opencode extrai o reasoning desse campo) |
| Reasoning por modelo | `models.*.reasoning: true` + `temperature: false` onde o modo thinking rejeita temperatura (deepseek-v4, kimi-k3, kimi-k2.7-code) |
| Janelas reais (context/output) | `models.*.limit.context/output` |
| Compactação inteligente (continuity brief) | `compaction{}` (auto + prune + tail_turns + preserve_recent_tokens) e o prompt de `compaction.md` |
| `--fully` / permissão total | `agent.harness.permission` (`edit/bash/webfetch: allow`) |
| Troca de provedor ao estourar limite | nativo no opencode: troque o modelo no picker; a sessão continua (não recomeça) |

## Chaves de API (variáveis de ambiente)

opencode lê a chave da primeira env var presente em cada provedor:

| Provedor | Env vars aceitas |
|---|---|
| deepseek | `DEEPSEEK_API_KEY` |
| glm | `ZAI_API_KEY`, `Z_AI_API_KEY`, `GLM_API_KEY`, `ZHIPUAI_API_KEY` |
| qwen | `DASHSCOPE_API_KEY`, `QWEN_API_KEY` |
| kimi | `MOONSHOT_API_KEY`, `KIMI_API_KEY` |
| inferx | `INFERX_API_KEY` |
| tokenrouter | `TOKENROUTER_API_KEY` |
| nvidia | `NVIDIA_API_KEY`, `NVIDIA_NIM_API_KEY` |

Ou rode `opencode auth login` e escolha o provedor.

## Como usar

Rode `opencode` dentro de `C:\Users\victo\Desktop\opencode-1.18.11`. O agente padrão é `harness` e o modelo padrão `deepseek/deepseek-v4-flash`. Trocar de modelo/provedor: `/models` no TUI (ou `opencode --model glm/glm-5.2`).

## Notas de fidelidade e versão

- **Versão instalada = 1.17.15**, a pasta-fonte é 1.18.11. A config foi validada contra a **1.17.15** (`opencode models` / `opencode agent list` carregam sem erro). Por isso `interleaved` usa a forma objeto `{ field: "reasoning_content" }`, aceita nas duas versões (a forma string só existe da 1.18 em diante).
- **Contrato de conclusão / `complete(...)`**: o Harness terminava com um tool `complete(status,answer,evidence)`. O opencode não tem esse tool; adicioná-lo seria forçar um fork do core. A disciplina foi preservada como instrução no prompt do `harness` ("texto puro é progresso, nunca prova; cite o resultado de tool que comprova"). O mesmo vale para `skill(id)`: o opencode tem tool `skill` nativo, então a instrução aponta para ele.
- **"Formas de chamada" de reasoning**: uso o caminho nativo e seguro (`reasoning` + `interleaved`) em vez de injetar `enable_thinking` / `thinking:{type}` / `reasoning_effort` crus no corpo — parâmetros que, no provedor errado, retornam 400 e queimariam a chamada. Se um provedor específico precisar do parâmetro explícito, dá pra adicionar por-modelo depois, de forma pontual.
- **"Correção das tools"**: as correções do Harness eram bugs nas tools *do próprio Harness*. As tools do opencode são outra implementação, já madura e com gating de permissão — portar o código não faz sentido. O que se transfere (contrato de permissão + evidência) está no `permission` e no prompt do agente.
