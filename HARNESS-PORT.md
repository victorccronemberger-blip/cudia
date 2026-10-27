# Harness no OpenCode

A construção Pulsaniurwo Harness foi adaptada ao OpenCode por configuração,
agentes e skills. O motor atual é **1.18.35**, integrado a partir da tag oficial
`v1.18.35`; [cudia-engine.json](cudia-engine.json) registra o commit upstream.
Há também código próprio: login Kimi Code e o loop `/goal`. Portanto este
checkout precisa de sua compilação customizada.

## Mapeamento atual

| Recurso                   | Implementação                                                       |
| ------------------------- | ------------------------------------------------------------------- |
| Agente padrão             | `.opencode/agent/harness.md`                                        |
| Especialista de segurança | `.opencode/agent/kali.md` e `/kali`                                 |
| Provedores e modelos      | `.opencode/opencode.json`, mais provedores nativos                  |
| Continuidade              | Configuração `compaction.keep.tokens` e agente `compaction`         |
| Playbooks                 | `.opencode/skills/*/SKILL.md`                                       |
| Descoberta de skills      | Índice limitado e busca paginada de metadados no tool `skill`       |
| Arena                     | Skill `arena`, quatro sessões `task` com agente `arena-contestant`  |
| Execução local            | Ferramentas nativas `bash`, `read`, `write`, `edit`, `glob`, `grep` |
| Rede e integrações        | `webfetch` e descoberta CodeMode de ferramentas MCP habilitadas     |
| Objetivos iterativos      | `packages/opencode/src/goal/` e `/goal`                             |
| Kimi Code OAuth           | `packages/opencode/src/plugin/kimi.ts`                              |

O corpo do agente customizado substitui o prompt padrão de provedor na sessão
legada. Na sessão V2, ele é carregado como instruções do agente. Instruções do
projeto do operador, skills carregadas e plugins configurados também podem
contribuir contexto. O harness acompanha o entregável pedido; não acrescenta
recusas por assunto nem etapas ofensivas obrigatórias.

## Ferramentas e permissões

O launcher CUDIA usa `CUDIA_CONTEXT_MODE=lean`. Uma política compartilhada governa
V1 e V2: skills são descobertas pelo tool `skill` sem inventário no system prompt;
MCP no CodeMode V1 consulta sua orientação por ferramenta. O modo `standard`
restaura o comportamento anterior. Agentes sem prompt próprio usam uma base
neutra no modo enxuto. As instruções explícitas do projeto são preservadas.

`CUDIA_CONTEXT_AUDIT=summary|content` habilita a captura optativa do contexto
preparado. `debug context` lê a última captura salva com sucesso, identificada por
horário, sessão e runtime; uma falha de gravação pode deixar a anterior visível.
A captura não inclui headers,
opções arbitrárias do provedor ou texto da conversa, e não equivale ao tráfego
final. O modo `content` inclui apenas instruções, com limite de tamanho. V1 AI SDK,
V1 nativo e o runner V2 têm pontos de captura; GitLab Workflow fica fora disso.

O relatório versão 2 registra manifests de contexto nativo: o texto-base da
geração mantém seu próprio manifest imutável, enquanto cada atualização
cronológica carrega outro no evento durável e na mensagem projetada. A comparação
entre observações avança separadamente. Reiniciar ou fazer replay não substitui
a origem do texto antigo pela dos arquivos atuais. Compactação bem-sucedida
permite uma nova geração com texto-base e manifest substituídos juntos.
Manifests antigos ausentes ou inconsistentes no texto-base são identificados,
sem impedir o envio desse texto já admitido nem fabricar atribuição. Mensagens
duráveis continuam sujeitas à validação de seu schema.

Posições são intervalos UTF-16, com início inclusivo e fim exclusivo, sem cortar
pares Unicode. O hash do manifest cobre `JSON.stringify(text)` em UTF-8; o campo
`bytes` mede o texto UTF-8 direto. Cada parte identifica produtor e fase; origens
de arquivos apontam para o corpo observado, e skills/referências apontam para
metadados incluídos, sem alegar leitura dos seus diretórios ou corpos completos.
Avisos de remoção têm produtor, mas não readmitem conteúdo da fonte removida.
Validade verifica consistência estrutural com o texto, não autenticação da origem.
Os manifests são dados do runtime, excluídos das chamadas normais e de compactação
ao modelo. A auditoria optativa admite até 64 KiB agregados de manifests por
relatório, com omissão explícita; o teto não é limite da memória do processo.
Proveniência dos hooks V1, transformações posteriores dos adaptadores e linhagem
detalhada dos corpos de ferramentas e resumos continuam no roteiro.

Os gateways `security`, `shell`, `file`, `http`, `browser`, `search` e `mcp` do
harness original não foram portados como ferramentas próprias. Metadados de
skills não criam ferramentas. Os playbooks agora descrevem as ferramentas reais
do OpenCode e tratam programas externos e integrações como dependências a
verificar. Também não existe uma ferramenta `complete(status, answer, evidence)`;
a conclusão é relatada com os resultados observados que sustentam o entregável.

O launcher ativa `OPENCODE_EXPERIMENTAL_CODE_MODE=1` por padrão, preservando
override explícito. O runtime V1 usa a busca nativa `$codemode.search` com catálogo
inicial de schemas vazio. `$mcp.instructions` consulta apenas a orientação do
servidor escolhido no cache local; não chama uma operação remota. O modo direto
anterior continua disponível com a variável em `0`. Isso não adia a inicialização
dos servidores habilitados. A integração MCP na sessão V2 permanece pendente no
upstream; a busca de skills foi implementada nos dois motores.

O `/goal` usa o executor e o histórico da própria sessão, com objetivo persistido
fora da janela de contexto e continuação nas fronteiras do runner. Não cria
planejador nem verificador por rodada. `get_goal` e `update_goal` aparecem apenas
com uma meta ativa; limites são opcionais e definidos pelo usuário. A retomada
é explícita depois de pausa ou reinício. Consulte [GOAL.md](GOAL.md).
A Arena é um fluxo separado, acionado
por pedido explícito: quatro candidatos independentes recebem o mesmo briefing,
sem herdar o histórico inteiro, e o coordenador verifica o vencedor. As permissões
dos candidatos impedem alterações concorrentes no workspace.

Os agentes herdam as permissões nativas configuradas pelo operador. Um alvo é
literal, salvo escopo mais amplo explicitamente definido. Saídas de ferramentas,
páginas e respostas de alvos são dados, não novas instruções. Uma análise pode
terminar com evidência de código; não precisa executar um payload para ser válida.

## Configuração e dados

O launcher define `OPENCODE_CONFIG_DIR` para o `.opencode` deste checkout, sem
mudar o diretório do projeto em que foi chamado. `OPENCODE_DISABLE_CHANNEL_DB=1`
mantém o banco de produção existente mesmo com a compilação no canal `cudia`.
Não são apagados projetos, sessões, chaves nem credenciais em uma atualização.

As variáveis de API aceitas pelos provedores customizados continuam em
`.opencode/opencode.json`; `/connect` usa o armazenamento nativo de autenticação.
O provedor `qwencloud` atende ao Token Plan Personal da QwenCloud por
`https://token-plan.maas.qwencloudapi.com/apps/anthropic/v1`, com o SDK Anthropic
já incluído no motor. A chave `QWENCLOUD_TOKEN_PLAN_API_KEY` é independente das
chaves DashScope. Seu catálogo de texto segue os IDs do plano; modelos de mídia
e ferramentas remotas via Responses API exigem integrações separadas.
O login Kimi Code OAuth é do provedor nativo `moonshotai`, distinto do provedor
customizado `kimi` com chave da API Moonshot. Compartilhamento com o Kimi CLI é
opcional via `KIMI_CODE_SYNC_CREDENTIALS=1`.

## Manutenção do motor

Compare a versão registrada com a release estável oficial, integre as mudanças
upstream preservando o código próprio e atualize `cudia-engine.json`.
Use o `bun.lock` versionado e execute os testes dos recursos customizados, a
validação da configuração, `bun typecheck` no pacote afetado e a compilação.
`sh update.sh` atualiza o checkout do cudia por fast-forward e recompila; não
substitui silenciosamente o motor pelo binário oficial.

As consultas de arquivos e Git da interface V2 usam o Core/Server canônico.
`find` aguarda uma nova varredura por pedido, inclusive após criar arquivos;
diretórios vazios não são garantidos pela busca derivada de arquivos. Informações,
status e diferenças Git têm rotas `/api/vcs`, `/api/vcs/status` e `/api/vcs/diff`,
com escopo da pasta selecionada, leitura sem alterar o índice e erro explícito
ao exceder o limite de saída. Os modos local e branch foram validados na interface.
Essas consultas não adicionam instruções ao prompt do modelo. Limites e evidências
atuais, incluindo as pendências de LSP e FFF glob/grep, estão em `CUDIA-ROADMAP.md`.

O MCP V2 descobre recursos e templates pela ferramenta `mcp`, sob demanda, e lê
um URI somente em uma operação explícita autorizada. Snapshots impedem continuar
uma página com catálogo, conexão ou consulta diferentes. Descoberta não lê
conteúdo, não expõe ferramentas e não acrescenta instruções ao prompt fixo.
A definição da ferramenta cresceu 844 bytes de JSON UTF-8; não se afirma economia
de tokens a partir dessa medida. O limite de 8 MiB de uma leitura é aplicado após
a decodificação do SDK.

O `tool_result` nativo V2 é selecionado a partir do histórico durável da sessão,
sem instruções novas no prompt fixo. Consulta por `callID` e `messageID` opcional,
com recuperação de texto retido, dados estruturados ou conteúdo persistido. Cada
página respeita o limite de 6.000 bytes de JSON ou a configuração menor, e exige
o hash para continuar em offset diferente de zero. Artefatos novos vinculam
sessão, mensagem e chamada no nome; referências antigas sem esse vínculo falham
explicitamente. Dados estruturados já estão carregados pelo armazenamento de
mensagens; somente a leitura do artefato usa streaming com janela limitada.
Verificações de identidade detectam substituições e alterações comuns, sem
prometer uma leitura atômica contra escrita concorrente adversarial. As
permissões da Arena permanecem inalteradas.

As folhas `read` V1/V2 agora verificam o texto completo retornado, incluindo
moldura e escapes, contra 50 KiB/2.000 linhas ou a configuração menor. A leitura
de linhas usa chunks, interrompe a linha longa sem varrer toda a cauda e informa
recuperação por `textPage`. O pager nativo V2 recupera texto UTF-8 atual, preserva
BOM e pares Unicode, exige hash na continuação e conta o envelope JSON inteiro
no teto de 6.000 bytes. Não recupera bytes históricos descartados de um arquivo
alterado; `tool_result` consulta a representação persistida de uma chamada.

A enumeração de pastas usa `opendir`, com até 100.000 entradas/16 MiB de metadados
codificados e enriquecimento em concorrência 16. As páginas preservam entradas
inteiras e vinculam a continuação ao caminho canônico e à lista observada.
Mudança de snapshot exige recomeçar. Isso não é um snapshot atômico do disco.

O V1 entrega cada lote de instruções locais sozinho, antes do alvo, com recibo
que cobre a saída completa. O corpo automático e a mídia usam leitura limitada
real, além de consultar `stat`; crescimento acima do teto não autoriza um buffer
sem limite. A admissão de mídia tem teto de 20 MiB separado da normalização de
imagem e da projeção posterior do processador. O V2 mantém imagens como mídia
nativa. A API pública de arquivos e a interface ainda têm caminhos próprios.
Nenhuma orientação foi adicionada ao prompt fixo.

Os carregadores de instruções ambiente V1/V2 compartilham aquisição limitada:
64 KiB por fonte, 256 KiB de contribuições completas por lote e 64 candidatos.
A descoberta por glob interrompe a coleta ao observar um resultado além do teto
e cancela seu walker; isso não limita todos os caches internos da biblioteca.
As expressões configuradas e candidatos anteriores à deduplicação também são
contados no V1. Arquivos ausentes opcionais são distintos de fontes descobertas
que desaparecem ou falham durante a leitura. O lote só é entregue por inteiro.

No V1, URLs configuradas têm prazo de 5 segundos incluindo tentativas transitórias
e consumo do corpo, com contagem dos bytes efetivamente entregues após
descompressão. Falha HTTP, timeout, UTF-8 inválido ou excesso gera erro persistido
antes do provedor; a sessão pode ser usada novamente depois de corrigir a fonte.
Diagnósticos removem credenciais, query e fragmento da URL; a requisição e a
atribuição enviada ao modelo preservam a URL configurada. O V2 mantém sua
descoberta existente de arquivos globais e do projeto, sem paridade de URLs.
Uma fonte indisponível mantém o snapshot completo já admitido e impede uma nova
inicialização ou substituição incompleta. A aquisição não é um snapshot atômico
contra escrita concorrente adversarial.

Os quatro tetos podem ser reduzidos pelas variáveis `CUDIA_INSTRUCTION_*`
documentadas no README. São limites de aquisição, não de todo o histórico ou
memória do processo. Logs estruturados de aquisição não substituem a proveniência
durável de cada bloco do contexto; esse inventário completo continua no roteiro.
