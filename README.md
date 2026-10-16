# cudia

Harness de IA para programação e trabalho de segurança. Usa o **OpenCode 1.18.35**
com agentes, skills sob demanda, continuidade de contexto, OAuth ChatGPT/Grok e o comando
`/goal`. A origem exata do motor está em [cudia-engine.json](cudia-engine.json).

Os agentes seguem o pedido do operador: explicar, revisar, planejar ou executar.
O CUDIA não impõe filtros por assunto nem proibições de ferramentas por papel de
agente. **Regras legadas `ask/deny` são preservadas como dados de compatibilidade,
mas não bloqueiam operações, geram confirmações nem escondem ferramentas.**
Restrições escritas no prompt do usuário continuam sendo instruções para o agente;
não são convertidas automaticamente em regras de bloqueio do runtime.

No V1, `write`, `edit` e `apply_patch` ficam disponíveis para todas as famílias de
modelos, sem seleção pelo nome. As descrições apresentam os contratos das operações,
sem exigir leitura prévia ou proibir documentação, novos arquivos ou emojis.
Seleções explícitas de ferramentas na mensagem do usuário continuam sendo respeitadas.

As descrições de shell, busca por arquivos, tarefas, Todo e skills apresentam seus
contratos técnicos, sem impor fluxo de Git, escolha de utilitários, delegação ou
quantidade de tarefas em andamento. O shell inicia um processo por chamada e
informa prazo e limites de saída. Skills continuam com descoberta por metadados e
carregamento do corpo sob demanda.

Arquivos, páginas e respostas de ferramentas conservam sua origem: seu conteúdo
não se torna uma nova instrução do usuário. Validação de entradas, autenticação,
isolamento entre sessões, limites de recursos e capacidades implementadas continuam
necessários ao funcionamento. Os modelos e serviços externos têm comportamento
próprio, que o CUDIA não remove nem controla.

## Instalação e uso

O [site oficial](https://cyara.com.br) mostra os downloads verificados de cada
canal. A Preview usa `cudia` no PATH e atualizações assinadas descobertas pelo
domínio do CUDIA. A sequência 12 está publicada com instaladores normal/baseline
e pacotes de atualização. Instalação, PATH, abertura em outra pasta e remoção
passaram em duas VMs Windows Server 2025 novas, sem Node, Bun ou Git no PATH.
No Windows desta máquina, a atualização real 11 → 12 e a resposta Grok passaram.
A Preview 12 inclui recuperação de Goal sem substituir estado ilegível, auditoria
opt-in de compactação/checkpoints e resumos auxiliares sem snapshots de arquivos.
Preserva MCP por chamada explícita, instruções remotas fora do sistema e limites
nos cabeçalhos agregados do catálogo. Os 21 testes compilados passaram por variante,
com 1.717 verificações em cada uma.
[Evidências da entrega](provenance/preview-12/README.md). A conferência posterior
do executável instalado também confirmou resposta ChatGPT com `openai/gpt-6-luna`.
A tasklist está em
[CUDIA-ROADMAP.md](CUDIA-ROADMAP.md). Os comandos abaixo iniciam ou instalam um
checkout de desenvolvimento.
O serviço independente de versões e as instruções de implantação ficam em
[deploy/updates](deploy/updates/README.md).
O [pacote Windows e cliente nativo](installer/windows/README.md) já têm
empacotamento, verificação de releases assinadas, atualização explícita e rollback
validados. Baixe o instalador no site e abra um CMD novo na pasta do seu projeto:

```cmd
cudia
```

Para atualizar uma instalação existente, execute `cudia update`. O motor padrão
usa o catálogo incluído no executável e os updates de `cyara.com.br`; não consulta
os serviços padrão hospedados pelo OpenCode. Provedores escolhidos continuam
usando suas próprias APIs. A distribuição continua Preview; a validação interativa
como usuário comum no Windows 10/11 e o certificado de editor Authenticode
permanecem pendentes.

### Checkout de desenvolvimento

As fontes da Preview 12 estão na branch `codex/mcp-on-demand`; o motor foi
compilado do commit `881809bd1c2a4c92823bdf4ae0668a04ed004e50`.
[MCP-ON-DEMAND.md](MCP-ON-DEMAND.md) descreve o contrato e sua validação.
As fontes históricas da Preview 9 estão na branch `codex/preview-source`.
[SOURCE-PREVIEW-9.md](SOURCE-PREVIEW-9.md) descreve os recibos, a correspondência
com o motor distribuído e como compilar com o catálogo congelado dessa versão.

Requisitos: Git, Node.js e Bun compatível com `packageManager` em `package.json`
(atualmente **1.3.14**). Os scripts suportam Linux, macOS, Git Bash e PowerShell
no Windows.
Dependências nativas podem exigir compilador C/C++; no Windows, o build nativo
do tree-sitter requer as ferramentas C++ do Visual Studio.

```sh
git clone --branch codex/mcp-on-demand https://github.com/victorccronemberger-blip/cudia.git
cd cudia
sh install.sh
cudia
```

`install.sh` compila este checkout e cria o launcher em `~/.local/bin/cudia`.
Adicione esse diretório ao `PATH` se necessário. `CUDIA_DIR` permite escolher
outro checkout; `CUDIA_BIN_DIR` muda o destino do launcher. Em máquinas x64 que
precisam de um binário sem AVX2, use `CUDIA_BASELINE=1 sh install.sh` e mantenha
essa variável ao iniciar o launcher.

Para iniciar um checkout já compilado sem instalar o launcher, use `sh run.sh`.

No PowerShell, use `run.ps1`, inclusive a partir da pasta de outro projeto:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\caminho\para\cudia\run.ps1" --agent harness --model qwencloud/qwen3.8-flash
```

Ele encontra o shell do Git for Windows automaticamente (também aceita o Git
incluído no runtime local do Codex), sem exigir `sh` no `PATH`. A pasta atual
continua sendo a pasta de trabalho do harness. Bun só é necessário nesse
launcher quando a fonte precisa ser compilada novamente.
`-ExecutionPolicy Bypass` vale apenas para esse processo; a política permanente
do Windows não é alterada. Se sua sessão já permite scripts locais, também pode
usar `& "C:\caminho\para\cudia\run.ps1"` com os mesmos argumentos.

O launcher conserva o diretório de trabalho do operador, carrega os agentes
deste checkout e compartilha o banco de sessões existente do OpenCode. Ele
recompila quando a fonte muda e não substitui uma compilação que falhou por um
binário antigo. Não instala nem atualiza uma cópia global do OpenCode.

Dentro do aplicativo, use `/connect` para autenticar e `/models` para escolher
um modelo. As chaves persistem no armazenamento nativo do OpenCode; não devem
ser colocadas no repositório. A configuração padrão e os provedores ficam em
[.opencode/opencode.json](.opencode/opencode.json).

### QwenCloud Token Plan

O provedor `qwencloud` usa o domínio próprio da QwenCloud e o protocolo Anthropic
compatível recomendado no [guia oficial para OpenCode](https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/opencode).
Use `/connect`, escolha **QwenCloud Token Plan** e informe a chave do plano
(`sk-sp-`). Também pode definir `QWENCLOUD_TOKEN_PLAN_API_KEY` no ambiente.
Em `/models`, procure QwenCloud e escolha, por exemplo, `qwencloud/qwen3.8-flash`.

O catálogo contém os 12 modelos de texto do Token Plan Personal, incluindo `auto`,
Qwen, GLM e DeepSeek. Qwen 3.8 usa esforço `medium` por padrão; as variantes `low`
e `xhigh` permitem ajustar custo e profundidade. O roteamento de `auto` é decidido
pelo serviço; seu orçamento local usa contexto de 1M e saída de até 65.536 tokens.

Essa chave não é a chave DashScope dos provedores `qwen`/`alibaba`, nem a chave
QwenCloud de pagamento por uso (`sk-ws-`). Os modelos usam as ferramentas locais,
Goal, Arena e MCP do cudia. As ferramentas remotas chamadas "Harness tools" pela
QwenCloud usam Responses API e ainda não estão integradas neste provedor.
Geração de imagem, áudio e vídeo também requer integrações próprias.

## Agentes e continuidade

- `harness`: agente padrão, orientado ao pedido e a evidências.
- `kali`: especialista de segurança; o nome não implica programas instalados.
- `compaction`: preserva objetivo, restrições, decisões e resultados observados.
- `/goal <objetivo> [--max-iterations N]`: trabalho iterativo com planejamento e
  verificação. `/goal status`, `/goal pause`, `/goal cancel` e `/goal resume`
  controlam a execução. Quando o orçamento acaba, use
  `/goal resume --max-iterations N` para autorizar novas iterações.

Skills são playbooks. Use `/skills` para selecionar uma, ou invoque pelo nome,
como `/code-review <pedido>`. Também podem ser carregadas quando a descrição
corresponde ao trabalho. Carregá-las não instala programas nem habilita ferramentas.
Os agentes usam ferramentas nativas do OpenCode e integrações MCP habilitadas.

## Arena

```text
/arena Corrija o problema X, mantendo Y e verificando Z
```

O agente atual coordena quatro candidatos em sessões novas, com a mesma missão,
critérios, modelo e variante. Cada candidato inspeciona o contexto relevante e
entrega uma solução ou proposta de patch. O coordenador compara a evidência,
aplica e verifica a melhor proposta quando o pedido envolve código, e entrega
somente o resultado escolhido. Os candidatos podem usar as ferramentas disponíveis,
incluindo edição, comandos e delegação. Para edições concorrentes, o coordenador
usa áreas independentes quando disponíveis; sem isolamento, executa candidatos
sequencialmente para evitar conflitos de escrita.

Peça Arena ou uma competição de quatro agentes para acioná-la. Ela não faz parte
do fluxo comum de cada tarefa. Usa quatro execuções de candidatos mais o trabalho
do coordenador; a resposta final curta não elimina esse custo. A seleção segue
os critérios da missão e não garante que uma proposta esteja correta.

## Economia de contexto

- O launcher usa **`CUDIA_CONTEXT_MODE=lean`**. Catálogos de skills e orientação
  MCP no CodeMode não são adicionados ao system prompt. Agentes sem prompt
  próprio recebem uma base operacional neutra e pequena.
- **Skills:** o modelo busca metadados pelo próprio
  `skill({query: "palavras"})`; `skill({name: "arena"})` carrega a escolhida.
  A busca aceita `offset` e `limit` e carrega o conteúdo somente quando escolhido.
- **Agentes no V1:** `agent_search({query: "palavras"})` pesquisa nomes e
  descrições, com paginação; `query: ""` permite listar. Agentes ocultos,
  primários não aparecem nessa busca de subagentes. A busca não inicia
  agentes nem carrega seus prompts. No modo enxuto, a descrição de `task` deixa
  de repetir o catálogo inteiro; a delegação continua usando `task`.
- **Goal:** objetivo e critérios ancoram a execução; continuações recebem
  alterações da verificação e novas instruções. Retomada ou compactação repõem
  o contexto necessário. A verificação continua independente e recebe objetivo,
  critérios e instruções completos; relatórios e evidências ficam no armazenamento.
- **MCP:** o launcher habilita o CodeMode nativo. Uma ferramenta `execute` fornece
  busca por nomes e schemas usando `tools.$codemode.search`, sem enviar todos os
  schemas a cada turno. Orientações de um servidor são lidas do cache com
  `tools.$mcp.instructions({server: "nome"})` quando ele é relevante. A operação
  escolhida é executada pelos adaptadores e hooks da integração.

Servidores MCP habilitados ainda inicializam normalmente; a descoberta adia
o envio de schemas e orientações ao modelo. Configure apenas as integrações
necessárias. O bridge Claude fica desabilitado por padrão. Para usar a exposição
direta de schemas, inicie com `OPENCODE_EXPERIMENTAL_CODE_MODE=0 cudia` no shell POSIX.
A economia real de tokens depende do modelo, do catálogo e da tarefa.
Schemas e descrições das ferramentas continuam consumindo contexto. Para manter
o índice compacto anterior no system prompt, use `CUDIA_CONTEXT_MODE=standard`.

## Inspeção do contexto

A partir da Preview sequência 6, a aplicação automática de `AGENTS.md`,
`CLAUDE.md`, `CONTEXT.md` e instruções configuradas fica desligada por padrão,
inclusive durante leituras de arquivos. `--load-instructions` ativa esse
comportamento explicitamente para o processo iniciado; documentos não podem
ativá-lo por configuração do projeto ou `.env`. Ler um documento continua
devolvendo seus dados, e instruções fornecidas diretamente pelo usuário permanecem
no pedido. Na CLI, `debug context --status` mostra a escolha atual sem chamar um
provedor, e `--context-audit summary|content` ativa a captura sem configurar
variáveis. Esses recursos foram conferidos nos dois executáveis publicados e
na atualização HTTPS desta máquina de 5 para 6.

O modo de auditoria é desligado por padrão. Antes de iniciar uma tarefa, defina
`CUDIA_CONTEXT_AUDIT=summary` para guardar contagens, tamanhos em bytes, hashes,
papéis das mensagens e nomes das ferramentas. `CUDIA_CONTEXT_AUDIT=content`
também permite guardar o texto das instruções. Nos fontes posteriores à Preview
11, também pode guardar o prompt de compactação e o checkpoint selecionado do V2,
que incluem histórico serializado da conversa. Todos esses textos compartilham
64 KiB; um bloco que não cabe fica omitido por inteiro. Headers e opções
arbitrárias dos provedores não são gravados pelo auditor.

Use `debug context` para ler os metadados da última captura salva com sucesso, ou
`debug context --content` para exibir o texto que foi capturado explicitamente.
Esses comandos não chamam um modelo. Só o último relatório é mantido, com limite
de 512 KiB; o horário, a sessão e o runtime identificam a captura. Se uma gravação
falhar, a execução continua e o comando pode mostrar a captura anterior.

Os fontes posteriores à Preview 12 também oferecem um
[histórico opcional de metadados](CONTEXT-HISTORY.md), desligado por padrão e
carregado somente quando habilitado. Esse incremento ainda não integra o
instalador Preview 12.

Desde a Preview 12, `purpose` distingue chamadas `main` e
`compaction` do V2. Nos fontes posteriores à Preview 12, os chamadores principais
e de compactação do V1 também fornecem essa identificação explicitamente.
Ausência desse campo continua significando finalidade não classificada; o nome
do agente não determina a finalidade. `messageSources` identifica o prompt de compactação
e o checkpoint da retomada como conteúdo de mensagem de usuário, separado das
instruções de sistema. Seus índices de mensagem e parte são baseados em zero;
os hashes e bytes descrevem o texto exato preparado, incluindo o wrapper do
checkpoint. `messageID` identifica o checkpoint persistido. `compactionMessageID`
reserva o ID do possível resumo antes de chamar o provedor: a captura também
existe quando a tentativa falha ou é cancelada, sem provar que o resumo foi salvo.
São incluídas até 128 fontes de mensagens; `omittedMessageSources` informa o
total omitido pelo teto de registros ou pelos 64 KiB de metadados compartilhados
com manifests e trace. Esses limites não limitam as mensagens enviadas ao modelo.
Na Preview 12, somente a última captura é mantida. O histórico opcional dos fontes
posteriores mantém metadados limitados e não estabelece linhagem completa dos
resumos. `debug context` oculta todos os textos capturados
até que `--content` seja solicitado, inclusive quando o arquivo contém texto.

No V1, o prompt de compactação é observado depois das transformações, no ponto
de captura de cada adaptador. Os índices descrevem as mensagens e partes dessa
representação final preparada. `compactionMessageID` identifica a tentativa
reservada, inclusive em falha, repetição ou interrupção. O checkpoint de retomada
V1 ainda não tem atribuição por ID às partes finais comprovada; chamadas auxiliares `small` e o
workflow remoto conservam suas exclusões existentes. Essa ampliação é em fonte,
fora do instalador Preview 12.

Nos mesmos fontes, `historySnapshot` registra os resumos selecionados na entrada
da conversão V1, depois dos hooks de mensagens. Conserva os IDs observados de
mensagem/parte, posições nessa entrada, bytes e hashes. `stage` é
`pre-model-conversion` e `mapping` permanece `unmapped-after-conversion`: esses
índices não apontam para as partes finais do pedido. O ID local do snapshot liga
essa observação à captura; `captureID` distingue capturas e tentativas que usam o
mesmo snapshot. Nenhum desses identificadores vai ao provedor. O texto só é
incluído no modo `content`, dentro do orçamento compartilhado; consultas de
metadados e o histórico opcional o removem.

Esse snapshot também observa resultados dos loaders V1 de skills e guidance MCP.
Os recibos locais descrevem o corpo carregado e o resultado inteiro separadamente;
truncamentos e alterações por hooks ficam visíveis como divergência. Recibos e
correlação ficam fora das mensagens e schemas do provedor.
[Contrato e limites de origem](CONTEXT-HISTORY.md#origens-no-histórico-selecionado-v1).
Essa cobertura é posterior à Preview 12 e ainda não inclui os loaders V2.

A captura cobre V1 AI SDK, V1 nativo e o runner V2. Ela observa o contexto
preparado antes do adaptador do provedor, não o tráfego final ou instruções
internas de um serviço remoto. O relatório pode ser salvo antes de uma falha do
provedor e não comprova aceitação ou conclusão da chamada. Falhas anteriores ao
ponto de captura deixam o relatório anterior disponível. As contagens de definições incluem os campos
normalizados nome, descrição e schema de entrada; não são contagens de tokens.
No V1, hooks e a transformação de mensagens são aplicados antes da captura.
Nas chamadas principais, `trace` registra cada execução observada dos hooks de
mensagens, texto de sistema e `options.instructions`, além da transformação de
mensagens do AI SDK. Cada registro contém a etapa, projeção observada, origem do
plugin, ordem de registro e de execução, resultado e hashes anteriores/posteriores.
Dois plugins que alteram e depois restauram o texto continuam aparecendo como
duas alterações. IDs repetidos são diferenciados pela ordem e pelo arquivo de
entrada observado. Esses rótulos não autenticam a autoria do plugin.

O rastreamento acompanha os arrays realmente consumidos, incluindo os casos em
que o motor ignora a substituição de uma propriedade do envelope do hook.
Ele não guarda os textos intermediários, headers, credenciais ou opções
arbitrárias. Cada snapshot inspeciona até 4.096 nós, profundidade 24 e 64 KiB de
codificação; getters, `toJSON`, ciclos ou valores não suportados não são executados
para produzir hashes. Acessores e snapshots incompletos ficam como alteração
desconhecida. Os hashes descrevem uma codificação tipada da projeção observada,
não os bytes enviados ao provedor. A inspeção não é um sandbox para código de
plugins ou traps de Proxy.

São mantidos até 64 registros por chamada. O rastreamento, os manifests e a
atribuição de mensagens compartilham 64 KiB de metadados; omissões do trace aparecem em `omitted`
e, quando causadas pelo orçamento do relatório, `traceOmission`. Com a auditoria
desligada, o fluxo não coleta snapshots nem calcula esses hashes. O histórico
de transformações permanece fora do prompt do modelo.
Atualizações cronológicas com papel `system` no V2 também são incluídas.
O relatório versão 2 distingue o texto-base durável, suas atualizações e o
prompt do agente ou a base enxuta. No V2, manifests acompanham o texto-base e
cada atualização persistida, preservando produtor, origem observada, hashes e
posições dos trechos através de reinício, replay e compactação. Arquivos usam
caminhos canônicos; skills e referências identificam somente os metadados
realmente incluídos. Esses manifests não entram no prompt do modelo.

`originState` distingue `valid`, `missing`, `invalid` e `omitted`. A validação
confere a estrutura e o vínculo com o texto, sem autenticar a origem declarada.
Sessões antigas sem manifest ficam como origem desconhecida, sem inferência a
partir dos arquivos atuais. O orçamento agregado dos manifests, fontes de mensagens e rastreamento no relatório é
64 KiB; excesso fica explicitamente omitido. `debug context` também lê capturas
antigas da versão 1, identificando sua origem como ausente. Mesmo `summary` pode conter caminhos
privados e identificadores de origem. Hashes dos manifests usam o texto codificado
como JSON UTF-8, com offsets UTF-16; hashes gerais de instruções e fontes de mensagens usam
UTF-8 direto. Os hashes das origens descrevem a entrada observada, que pode
diferir de sua formatação. O rastreamento cobre as projeções instrumentadas das
chamadas principais V1; hooks de definições/resultados de ferramentas, chamadas
auxiliares, transformações do adaptador, corpos de skills carregadas por ferramenta
e resumos históricos ainda não têm essa proveniência completa. No runtime V1
nativo, os hooks instrumentados aparecem, mas a conversão nativa posterior não
tem um registro próprio de transformação.
O caminho especial GitLab Workflow não passa por essa captura.
Nesse caminho, o runtime mantém um modelo separado por sessão/provedor/modelo e
serializa chamadas da mesma sessão até o fim do stream. A conclusão normal
preserva a identidade remota; cancelamento, falha e descarte encerram a instância
afetada. Regras legadas `ask/deny` não acionam aprovação nem retiram ferramentas
preparadas. O limite de retenção é 128 entradas por instância, ajustável com
`CUDIA_WORKFLOW_SESSION_LIMIT`; ao atingir o limite, entradas existentes continuam
disponíveis e uma nova entrada retorna um erro de capacidade, sem expulsão
silenciosa. Excluir sessões ou descartar/recarregar a instância libera o estado.
Uma criação remota já enviada ao GitLab não pode ser desfeita por essa lógica;
o cancelamento observado impede a conexão e o início posteriores dessa chamada.
O diagnóstico acompanha as chamadas principais instrumentadas; chamadas auxiliares
de resumo e compactação podem ficar fora dele. Não é um inventário completo de
todas as chamadas internas do motor.

## Recuperar conversas

`session list` mostra as conversas do projeto atual. Use
`session list --all --max-count 10` para procurar nos outros projetos, ou
`session list --all --search "parte do título" --format json`. Isso consulta o
armazenamento local sem chamar um modelo. Para retomar, abra a pasta indicada
no resultado e inicie o launcher com `-s <id>`.

Na ferramenta `task`, omitir `task_id` cria uma sessão filha. Informar um ID
continua a sessão existente. Se a busca falhar, o erro é reportado sem criar outra
tarefa silenciosamente; isso também vale para um ID vazio.

A meta e os critérios da evolução estão em [CUDIA-ROADMAP.md](CUDIA-ROADMAP.md).

## Compactação e pesquisa na internet

A compactação automática já faz parte do motor. O checkpoint compartilhado por
V1 e V2 agora pede objetivo, decisões, escopo/permissões, trabalho concluído e
pendente, evidências, arquivos e IDs de tarefas. Operações de resultado incerto
continuam marcadas como incertas. Essas instruções só entram na chamada de
compactação, fora do system prompt fixo do executor.

Desde a Preview 12, mensagens auxiliares marcadas internamente
como resumo não capturam snapshots de arquivos. A compactação mantém seus
registros de etapa, consumo, erros, tentativas e interrupções. As execuções
normais continuam capturando o estado antes de iniciar o provedor e suas
ferramentas. Plugins ainda podem alterar arquivos por efeitos próprios; a
compactação não acompanha incidentalmente essas alterações com um diff.

O CUDIA mantém uma cauda recente de aproximadamente 8.000 tokens, ajustada ao
orçamento disponível. A poda adicional de resultados antigos de ferramentas
permanece desabilitada por padrão. No V1, resultados omitidos ou abreviados no
contexto agora conservam referências com `messageID` e `partID`. A ferramenta
`tool_result` recupera páginas do texto gravado na mesma sessão, sem executar
novamente a ferramenta original. Continue com `nextOffset` e `outputHash` da
primeira página; uma alteração na saída interrompe a continuação. Os deslocamentos
usam unidades UTF-16, com proteção contra divisão de pares Unicode.

Cada resposta JSON de recuperação cabe em 6.000 bytes ou no limite configurado,
se menor. A permissão nativa `tool_result` controla a consulta ao histórico;
revogar uma ferramenta original não apaga o histórico já gravado. `captureTruncated`
informa se a captura original registrou perda de conteúdo, ou `null` quando não
há essa informação. Anexos não são recuperados por essa ferramenta, e excluir
a sessão elimina a recuperação. A poda usa um evento durável que verifica a
versão da saída e altera somente seu marcador de contexto, preservando o texto.

No V2, `tool_result` aparece sob demanda quando a sessão tem resultados
recuperáveis. Use `callID` e, se disponível, o `messageID` da referência de
retenção. IDs ambíguos exigem a mensagem exata. `source: "text"` recupera a
projeção completa retida; `"structured"` serializa os dados estruturados gravados
e `"content"` serializa o array de conteúdo persistido, incluindo mídia em linha.
Esse array pode conter texto abreviado, indicado por `contentTextBounded`.
Referências antigas sem vínculo de propriedade e artefatos expirados falham
explicitamente. A consulta mantém o mesmo limite JSON, hash e permissão nativa,
inclusive após reabrir ou compactar a conversa. Ela recupera a representação
armazenada, sem reconstruir bytes perdidos na captura original ou o formato do
JSON enviado pelo serviço externo.

As instruções locais anexadas por `read` são verificadas pelo caminho real,
contidas na raiz do projeto e autorizadas individualmente antes da leitura.
Os lotes automáticos usam até 16.384 bytes de JSON, ou o limite configurado se
menor, e até oito documentos por resposta. Um documento que ultrapassa sozinho
esse envelope retorna um erro explícito; a leitura real do corpo também respeita
esse limite, inclusive se o arquivo crescer depois de `stat`. Cada lote vem
sozinho, antes do conteúdo do alvo ou de seus anexos. Após recebê-lo, repita a
leitura do alvo para continuar.

`read` com `textPage: {}` permite ler texto exato, inclusive linhas longas,
preservando as quebras de linha e o BOM UTF-8. Continue com `nextOffset` e
`contentHash`; cada JSON cabe em 6.000 bytes ou no limite configurado se menor.
O hash é do texto decodificado, e os deslocamentos são unidades UTF-16. Cada
página percorre o arquivo inteiro para calcular o hash, retendo apenas a janela
solicitada. Não é um snapshot imutável do sistema de arquivos.

Falhas, recusas e resultados apenas salvos no banco não provam entrega. Novos
resultados de instruções precisam de recibos completos, consistentes e presentes
no contexto selecionado. Páginas explícitas verificadas também podem satisfazer
a leitura, desde que todas permaneçam nesse contexto. Uma compactação pode
removê-las; não há garantia de progresso para conjuntos de instruções maiores
que o contexto disponível. Recibos antigos sem esse formato ainda usam os
metadados de compatibilidade. Instruções globais e da raiz têm outro carregador.

As ferramentas `read` V1/V2 limitam a resposta textual completa a 50 KiB e 2.000
linhas, ou à configuração menor, contando a moldura e os escapes JSON. Linhas
abreviadas apontam para `textPage`. No V2, essa recuperação exata também está
disponível; ela consulta o arquivo atual e exige o hash para continuar. Pastas
usam entradas completas, com `snapshot` obrigatório após o primeiro offset.
Uma enumeração acima de 100.000 entradas ou 16 MiB de metadados retorna erro
explícito. Imagens e PDFs admitidos pelo V1 têm teto de entrada de 20 MiB;
o V2 aplica esse teto às imagens suportadas. Esses limites são das ferramentas;
as APIs de arquivos da interface ainda precisam de tratamento separado.

O carregamento de instruções ambiente tem limites próprios: 64 KiB por fonte,
256 KiB por lote completo, incluindo caminhos e separadores, até 64 candidatos
e prazo de 5 segundos para cada requisição remota, incluindo o corpo. As variáveis
`CUDIA_INSTRUCTION_MAX_SOURCE_BYTES`, `CUDIA_INSTRUCTION_MAX_TOTAL_BYTES`,
`CUDIA_INSTRUCTION_MAX_SOURCES` e `CUDIA_INSTRUCTION_TIMEOUT_MS` permitem reduzir
esses tetos. Valores inválidos ou superiores falham na configuração.
O conteúdo é adquirido sequencialmente, sem admitir lotes parciais. Falhas de
acesso, UTF-8, tamanho ou HTTP são explícitas; corrigir a fonte permite tentar
novamente na mesma sessão. No V1, a falha encerra a resposta com erro persistido
antes de chamar o provedor. No V2, uma observação indisponível preserva o contexto
completo anteriormente admitido e bloqueia inicialização ou substituição que
precise dessa fonte. Esses tetos não limitam todo o histórico nem a memória do
processo. URLs configuradas continuam sendo carregadas pelo V1; o V2 conserva
sua descoberta de arquivos globais e `AGENTS.md` do projeto.

O V2 compacta automaticamente, recupera estouro de contexto e oferece compactação
manual pelo endpoint `POST /api/session/:sessionID/compact`. A chamada aguarda uma
fronteira em que o turno e suas ferramentas estejam concluídos. O resumo usa o
modelo selecionado, sem ferramentas, e só substitui o contexto após terminar com
sucesso. Respostas vazias, cortadas ou sem conclusão confirmada mantêm o checkpoint
anterior. A qualidade do conteúdo ainda depende do modelo.

Arquivos com `provider` no formato antigo também preservam `compaction.keep.tokens`
e `compaction.buffer`; se os nomes antigos forem definidos explicitamente, eles
têm precedência, inclusive quando valem zero.

Compactar uma sessão ociosa não inicia outra resposta nem promove entradas pendentes.
Se não houver contexto antigo elegível, a operação termina sem chamar o provedor.
Durante uma execução, a continuação preserva seu limite de passos e recarrega
histórico, ferramentas e contexto depois do resumo. Pedidos manuais entram em fila
no processo atual; reiniciar o processo não os repete. Cancelar apenas o cliente
que aguarda não interrompe a sessão compartilhada; use a interrupção da sessão para
cancelar a operação e a fila. Pedidos manuais sucessivos podem adiar a geração.

O launcher habilita `websearch` também para provedores personalizados, incluindo
QwenCloud. A busca usa o backend Exa existente, ou Parallel quando selecionado,
somente ao chamar a ferramenta; `webfetch` lê URLs. A disponibilidade da busca
depende desses serviços. O catálogo disponibiliza `websearch` para qualquer
provedor, sem depender da flag legada `OPENCODE_ENABLE_EXA`.

Para renderizar JavaScript e clicar, o V1 inclui `cudia-browser`, baseado no
[Playwright MCP](https://github.com/microsoft/playwright-mcp), fixado em `0.0.83`.
Ele começa desativado. Descubra `$mcp.servers` e `$mcp.connect` pelo `execute`;
conecte `cudia-browser` quando precisar dele e descubra suas ferramentas numa
nova chamada. Nenhum processo de navegador é iniciado pela simples descoberta.
O comando gerenciado `cudia:browser` prepara Node portátil, o pacote fixado e
Chromium automaticamente em Windows x64, apenas na primeira conexão. O runtime
fica no cache do usuário e não altera o PATH; a primeira preparação exige Internet.
Listar servidores ou iniciar o harness não baixa essas dependências. Outros
sistemas podem configurar um MCP local ou remoto explicitamente. A
[Preview sequência 5](https://github.com/victorccronemberger-blip/cudia/releases/tag/cudia-preview-20261016-1b9ea9a042e6)
inclui esse provisionamento. Instalação privada do ZIP assinado, perfil vazio e
PATH System32 passaram em navegação, JavaScript, clique e encerramento dos processos;
a qualificação em uma instalação limpa de Windows continua pendente.
O navegador usa perfil isolado, sem reutilizar os logins pessoais do operador.

A skill `browser` contém o fluxo de navegação. Snapshots podem ser retornados
como caminhos de arquivos para leitura seletiva. Conexões são compartilhadas
no runtime do projeto; `$mcp.disconnect` encerra uma por pedido explícito.
Conexão e chamada de ferramenta são operações distintas; os registros legados
de permissão são inertes.
Para invocar deliberadamente, use `/browser <tarefa>` na sessão do harness.

No V2, a ferramenta nativa `mcp` conecta servidores locais e HTTP sob demanda.
Mesmo servidores configurados como habilitados aguardam uma conexão explícita;
abrir o projeto ou listar servidores não inicia processos nem acessa a rede.
Use estas operações em chamadas separadas:

```json
{"operation":"connect","server":"cudia-browser"}
{"operation":"search","server":"cudia-browser","query":"navigate"}
{"operation":"expose","server":"cudia-browser","names":["browser_navigate"]}
```

Conexão e pesquisa retornam metadados. `expose` retorna o nome público que pode
ser chamado no próximo turno do provedor. Só os schemas escolhidos entram no
contexto daquela sessão: até oito ferramentas por pedido, 32 por sessão e
32 KiB de definições serializadas no total. `hide` remove as escolhas daquela
sessão; `disconnect` encerra a conexão compartilhada e remove as exposições de
todas as sessões que a usam. Mudanças no catálogo invalidam chamadas antigas;
pesquise e exponha novamente. Falhas de chamada não provocam repetição automática.
O prazo de descoberta cobre todas as páginas do catálogo; a desconexão aguarda
o pedido em curso terminar ou alcançar esse prazo, além do encerramento do transporte.

A nomenclatura legada `mcp.*` e seus recursos permanecem como dados de
compatibilidade, sem bloquear operações ou solicitar aprovação. Os recursos
literais usam `~` seguido dos bytes UTF-8 em hexadecimal. Em `mcp.call`,
os componentes codificados de servidor e ferramenta são separados por `/`.
Por exemplo, `fixture/echo` corresponde a `~66697874757265/~6563686f`.
Os nomes originais acompanham os metadados. Regras armazenadas, inclusive recursos
`*`, não modificam a execução.

O MCP V2 aceita cabeçalhos configurados e OAuth pelo serviço canônico de
integrações. Um cabeçalho `Authorization` explícito tem precedência sobre tokens
gerenciados. O operador inicia o login; conectar ou receber um desafio de
autenticação não abre um navegador nem inicia OAuth automaticamente. Esse login
é separado da autenticação do provedor do modelo.

`GET /api/integration` lista a integração `MCP: <servidor>`. Use o seu `id` em
`POST /api/integration/:integrationID/connect/oauth`, com o corpo
`{"methodID":"oauth","inputs":{}}`. Abra a URL retornada e consulte
`GET /api/integration/attempt/:attemptID` até a tentativa terminar. Os endpoints
aceitam `location[directory]` para selecionar o projeto. Depois do login,
conecte o MCP e exponha as ferramentas escolhidas.

No V2, `GET /api/mcp` lista somente metadados dos servidores configurados, sem
iniciar conexões ou carregar schemas no contexto. `POST /api/mcp/:server/connect`
e `POST /api/mcp/:server/disconnect` usam o mesmo gerenciador do Core e retornam 204. Esses controles administrativos exigem a autenticação do servidor quando
configurada. A listagem distingue `toolCount` do total de registros expostos em
todas as sessões, `exposureCount`; a ferramenta do agente mantém sua contagem por
sessão. Conectar pela API não expõe ferramentas ao modelo nem dispensa suas
permissões nativas. Os controles V1 continuam usando o caminho legado.

A ferramenta nativa `mcp` do V2 oferece `resources` e `templates` para procurar
metadados de um servidor conectado, e `read` para ler um URI exato. As páginas
usam `snapshot` e `nextOffset`; mantenha a mesma consulta na continuação. Conectar
não busca documentos nem inclui seus conteúdos no prompt. A leitura depende da
permissão nativa e entrega conteúdo externo como resultado de ferramenta.
Os metadados retornados têm envelope de 6.000 bytes; a leitura aceita até 8 MiB
do resultado JSON já decodificado pelo SDK. Isso não limita os bytes recebidos
na rede nem a memória do SDK. Resultados grandes aceitos usam a retenção normal;
o `tool_result` V2 permite recuperar páginas exatas de linhas longas e consultar
blobs na representação estruturada gravada, sem repetir a leitura MCP.

Na interface, os controles V2 usam essa API e carregam a janela OAuth somente
quando o operador escolhe autenticar. Concluir o login deixa uma ação separada
de conectar; fechar a janela cancela a tentativa. A janela consulta o estado por
até aproximadamente dois minutos e mostra uma falha se esse prazo terminar;
o servidor mantém sua validade de dez minutos. O catálogo de recursos já está
disponível pela ferramenta nativa V2; o seletor de recursos da interface ainda
não o consulta nesse protocolo.
Alterações por ferramenta não têm um novo evento de atualização MCP neste
incremento; a tela consulta o estado após suas ações e ao recuperar o foco.
O health nativo identifica o protocolo com `protocol: "v2"`; servidores híbridos
continuam preferindo os caminhos V1 quando publicam o health legado.

Projetos e seleção de pasta usam agora o cliente canônico no servidor V2.
`GET /api/project` lê os metadados persistidos sem inicializar uma pasta;
`GET /api/location/paths` informa a pasta pessoal e o diretório padrão reais do
servidor. Ambas as rotas exigem a autenticação configurada. O seletor usa
`/api/fs/list` e `/api/fs/find`, expande `~` com a pasta pessoal do servidor e
descarta do cache as consultas de pasta que falharam. A pasta escolhida permanece separada da raiz do projeto;
abrir uma pasta comum nesse fluxo V2 não inicializa Git automaticamente.
Árvore, busca e leitura de arquivos também usam o transporte V2. A leitura
preserva texto UTF-8, BOM e espaços; conteúdo inválido em UTF-8 ou com bytes NUL
é apresentado como binário. Trocar de projeto cancela leituras pendentes e
descarta respostas antigas. Essas consultas da interface não entram
automaticamente no contexto do modelo. Os metadados de arquivos ignorados ainda
não são fornecidos pela API V2.
O histórico separa a quantidade de mensagens desejada do limite de 200 por
requisição; uma conversa vazia não gera uma consulta com limite zero no V2.
O caminho V1 conserva esse limite quando solicitado explicitamente.
Agentes e provedores também usam os contratos canônicos, e o endpoint
`GET /api/model/default` preserva o modelo padrão escolhido pelo motor. Uma data
de lançamento fora do formato aceito fica vazia, sem derrubar o catálogo.
A abertura de uma pasta aguarda a configuração interna do catálogo antes de
publicá-lo, para a primeira consulta também respeitar o modelo configurado.
Custos ausentes ainda viram zero na projeção legada da interface; distinguir
preço desconhecido exige adaptar esse contrato e seus consumidores. Não se
declara paridade de toda a interface. Ainda há consumidores legados na recuperação
de diretórios associados a projetos. Informações, status e diferenças Git usam
agora o Core V2, incluindo os modos de alterações locais e da branch. A leitura
preserva o índice, limita a saída e rejeita falhas sem apresentar um diff vazio
como resultado válido. Essas consultas da interface não entram no prompt.
A interface usa o status LSP nativo V2, com o transporte autenticado e a Location
selecionada. A consulta de status não inicia servidores de linguagem; eventos
`lsp.updated` atualizam a consulta. Esse caminho foi validado em testes e checagem
de tipos, mas sua apresentação visual e o pacote web embutido ainda aguardam QA.
Cada busca de arquivos aguarda uma nova varredura
e reflete criação, exclusão, renomeação e mudanças nas regras de exclusão. Não há
watcher obrigatório. Diretórios são derivados dos arquivos encontrados; a busca
não garante descoberta de diretórios vazios. A prontidão das operações nativas
FFF de glob/grep continua fora dessa garantia.

O fluxo verifica estado, emissor, PKCE e recurso antes de guardar a credencial.
O callback padrão é `http://127.0.0.1:19876/mcp/oauth/callback`; `oauth.callback_port`
ou `oauth.redirect_uri` podem alterá-lo no formato V2. O servidor precisa publicar
metadados de recurso e autorização compatíveis. É possível usar `client_id`,
registro dinâmico anunciado pelo servidor ou `client_metadata_url` quando o
servidor anuncia esse suporte. Os equivalentes V1 usam nomes em camelCase.

Remover uma conexão invalida o token em memória e suas ferramentas expostas.
Respostas 401/403/404 não repetem a chamada MCP. Uma renovação de resultado incerto
fica registrada no banco antes do envio, e o Core V2 não a repete automaticamente
após reiniciar. Uma nova autorização substitui a credencial; alterar seu rótulo,
validade ou metadados preserva o registro da tentativa. Se o processo cair antes
de enviar, a recuperação também pode exigir nova autorização: não há como deduzir
com segurança se o serviço externo recebeu a chamada.

O banco usa WAL com `synchronous=FULL`, acrescentando sincronização de disco por
transação. Isso melhora a durabilidade e tem custo de escrita; depende de o
armazenamento cumprir a sincronização. O teste com encerramento forçado comprova
recuperação de processo, sem simular queda de energia. Consulte a
[documentação do SQLite](https://www.sqlite.org/pragma.html#pragma_synchronous).
Os caminhos legados que não usam esse protocolo de renovação ficam fora dessa
garantia. O limite de catálogo é aplicado após a leitura da resposta e não
representa um limite de memória para os bytes recebidos na rede.

## LSP nativo V2

A ferramenta `lsp` inicia servidores de linguagem sob demanda para consultar
definições, referências, hover, símbolos, implementações, hierarquia de chamadas
e diagnósticos. `lsp: false` desativa essa capacidade; `true` descobre comandos já
instalados na primeira consulta. Um objeto `lsp` permite escolher comandos e
extensões. Não há instalação automática de servidores ou dependências.

Para obter diagnósticos explicitamente:

```json
{ "operation": "diagnostics", "filePath": "src/app.ts", "line": 1, "character": 1 }
```

As posições positivas fazem parte do schema compartilhado, mas são ignoradas
nessa operação. O resultado informa servidor, versão, geração, origem push/pull,
frescor, itens e omissões. Um relatório sem versão aparece como `unversioned`;
isso não confirma que o arquivo atual está sem erros. Resultados `current`
conferem geração, versão e hash do arquivo.

Com LSP configurado, `write`, `edit` e `apply_patch` também consultam diagnósticos
após confirmar as alterações, fora do lock de gravação. Invalidam primeiro os
relatórios dos caminhos efetivamente alterados; depois coletam até quatro
arquivos elegíveis, com um prazo de três segundos para essa coleta. O complemento
tem até vinte diagnósticos, mensagens de 512 bytes e 8 KiB de texto serializado,
incluindo metadados e contagens de omissões. Arquivos excluídos fecham documentos
existentes no servidor, sem iniciar outro processo para isso.

A inicialização pode ultrapassar esse prazo. O arquivo continua salvo e o
resultado informa o timeout; uma consulta explícita posterior reutiliza a
inicialização compartilhada. Erros do LSP não transformam uma gravação confirmada
em falha de escrita. Um patch parcialmente aplicado continua sendo falha e
preserva sua lista de operações aplicadas. Interrupções e defeitos podem impedir
o complemento, sem desfazer os arquivos já alterados.

Sem LSP ou quando nenhum arquivo alterado tem suporte, a resposta mantém seu
formato anterior. Os relatórios descrevem os arquivos observados durante a
consulta, que podem incluir mudanças posteriores de outro escritor; não
certificam os bytes exatos de um commit anterior. Essa integração não adiciona
instruções ao prompt fixo nem faz chamadas adicionais ao modelo.

Arquivos externos podem ser consultados pelo mesmo servidor configurado, sem
carregar a configuração de outro projeto. URIs retornadas são metadados e não
provocam leitura dos seus destinos. Regras legadas `deny` não impedem a operação.
`GET /api/lsp` informa somente status e não inicia processos.

## Builds paralelos no Windows

Se o executável estiver em uso, gere uma cópia sem encerrar a sessão antiga:
o script de build aceita `--output-dir dist-preview`. O launcher seleciona esse
diretório com `CUDIA_BUILD_DIR=dist-preview` e valida sua própria assinatura de
fontes. Os diretórios permitidos são `dist` e `dist-<nome>` dentro do pacote.
Uma cópia separada não significa que o binário padrão já foi substituído.

Para usar a cópia de teste já compilada nesta instalação Windows:

```powershell
$env:CUDIA_BUILD_DIR = "dist-cudia-preview"
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\OneDrive\Documents\ChatGPT\LLM\cudia\run.ps1" --agent harness
```

Esse `Bypass` vale somente para o processo iniciado, sem alterar a política
permanente do PowerShell. A sessão antiga pode continuar aberta.

## Kimi Code

O plugin integrado autentica o provedor `moonshotai` por OAuth e usa o endpoint
de coding correspondente. Por padrão, esse login fica separado do Kimi CLI.
Para compartilhar deliberadamente as credenciais com `~/.kimi-code`, defina
`KIMI_CODE_SYNC_CREDENTIALS=1` antes do login. Se mudar entre OAuth e chave de API
durante uma sessão, reconecte o provedor para recriar seu endpoint e catálogo.

## Atualização e verificação

```sh
sh update.sh
```

O updater exige checkout sem alterações rastreadas e atualização por fast-forward,
preserva sessões e compila a fonte customizada. A atualização automática oficial
fica desligada para não substituir esse motor. `remove.sh` remove apenas o
launcher instalado; o checkout e os dados permanecem disponíveis.

Os testes são executados por pacote, nunca na raiz:

```sh
cd packages/opencode
bun typecheck
bun test test/plugin/kimi.test.ts test/goal test/session/retry.test.ts
bun test test/config/markdown.test.ts test/config/v2-compat.test.ts
bun test test/tool/arena.test.ts test/tool/skill.test.ts test/tool/code-mode.test.ts

cd ../core
bun typecheck
bun test test/skill/catalog.test.ts test/skill/guidance.test.ts test/tool-skill.test.ts
```

O contrato do bridge opcional com Claude é verificado com `node test.mjs` dentro
de `.opencode/mcp/claude-bridge`. Ele fica desabilitado por padrão. Os launchers
têm testes em `script/cudia-launchers.test.sh`.

Veja [HARNESS-PORT.md](HARNESS-PORT.md) para detalhes da adaptação. O projeto usa
o OpenCode sob a licença [MIT](LICENSE), com customizações independentes do time
OpenCode.
