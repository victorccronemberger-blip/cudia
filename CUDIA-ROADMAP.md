# Evolução do CUDIA

Meta iniciada em 15/10/2026: um harness robusto, econômico e auditável, com execução
local, recuperação e coordenação de ferramentas e agentes. “Limpo” significa não
adicionar filtros locais por assunto, recusas categóricas ou ações ofensivas
obrigatórias. Isso não promete mudar comportamentos internos de modelos ou
serviços externos, nem equivalência de qualidade com outro modelo.

O estado do trabalho, relatórios, catálogos e integrações pertencem ao runtime e
ao armazenamento local. O modelo recebe um núcleo operacional pequeno e descobre
capacidades quando precisa delas. Descrições e schemas de ferramentas também
consomem contexto: mudar texto de lugar não prova economia.

A orientação mais recente do operador substitui o critério anterior de escopo,
permissões nativas e Arena somente leitura: o produto deve permitir operações,
sem proibições próprias por assunto, ferramenta ou papel de agente. Regras legadas
`ask/deny` permanecem armazenadas, mas deixam de bloquear ou ocultar capacidades.
Restrições do prompt do usuário orientam o agente; não são compiladas em políticas
automáticas. Origem de conteúdo, autenticação, identidade, isolamento entre sessões
e limites operacionais conservam funções técnicas distintas.

Os relatos históricos abaixo descrevem os contratos de seus respectivos
incrementos. Referências antigas a negações, escopo imposto e Arena somente leitura
não representam a política atual. A auditoria não autoriza uma afirmação universal
de que nenhuma dependência, integração ou prompt externo possa impor limites.

## Primeira entrega — escopo confirmado pelo operador em 16/10/2026

Fechar OAuth ChatGPT/Grok, instalador Windows com `cudia` no PATH e atualizações.
As demais melhorias avançadas ficam para uma versão posterior; não ampliam o
critério de conclusão desta entrega.

**Entrega disponível em 16/10/2026:** Preview sequência 9, motor
`1.18.35+cudia.a1c9471a1874.34d5ef8b73ad`, em https://cyara.com.br.
Os quatro downloads imutáveis foram verificados pelo publicador; o manifest
assinado foi ativado por último. Instalação, CMD em outra pasta, catálogo frio,
PATH e remoção passaram nas duas variantes em VMs Windows Server 2025 novas
([execução de CI](https://github.com/victorccronemberger-blip/cudia/actions/runs/38901518617)).
A instalação física desta máquina passou de 6 para 9, preservou a versão anterior,
confirmou a consulta HTTPS e recebeu uma resposta Grok. As candidatas 7 e 8 foram
retiradas antes da ativação após os testes identificarem incompatibilidades de
aliases Windows; a sequência 9 contém as correções. Os serviços padrão OpenCode
foram retirados do fluxo padrão; APIs dos provedores selecionados permanecem.

- [x] Instalador compilado: instalar/reparar/remover, pasta Unicode, PATH e
      preservação do SQLite local; 16 retomadas de interrupção passaram no
      ensaio isolado de 16/10, com o candidato `31d2c80a4998`.
- [x] Vincular recibo e inventário observado do motor ao pacote e ao instalador;
      nove testes de origem e 14 fluxos compilados por variante passaram nesse candidato.
- [x] Corrigir validação, renovação, persistência e cancelamento do OAuth xAI em fonte;
      38 testes locais passaram, incluindo SDK Responses, renovação e cabeçalhos do proxy.
- [x] Integrar e validar o novo fluxo oficial Continue with ChatGPT, preservando
      separadamente as credenciais antigas do Codex.
- [x] Confirmar login e resposta real em streaming nas contas ChatGPT e Grok;
      ambos responderam em fonte e no executável em 16/10/2026. Renovações reais
      trocaram tokens nos provedores e salvaram os novos pares; a expiração foi
      antecipada apenas na visão em memória do ensaio, sem editar o prazo salvo.
      O catálogo ChatGPT também foi consultado. Concorrência tem testes locais.
- [x] Gerar/promover o motor `9c3e01c957f2` com OAuth e produzir instaladores Preview
      normal/baseline. Fonte: 128 testes passaram e um skip preexistente. Os 14
      fluxos compilados por variante passaram; o ensaio inicial precisou do prazo
      correto e das variáveis do LSP para os dois fluxos restantes.
- [x] Publicar e validar a Preview assinada em `cyara.com.br`: instalação real
      por usuário, CMD em outra pasta sem Git/Bun, consulta HTTPS e atualização
      sequência 1 → 2, seguida de resposta Grok e nova consulta sem update pendente.
      Os seis downloads públicos tiveram tamanho e SHA256 conferidos.
- [x] Testar a distribuição final em duas VMs Windows Server 2025 novas, com
      PATH mínimo e instaladores de produção normal/baseline.
- [ ] Validar interativamente como usuário comum em Windows 10/11.
- [ ] Configurar identidade de editor Authenticode; a assinatura Ed25519 dos
      updates já funciona e não substitui esse certificado do Windows.

O candidato `31d2c80a4998` acima foi validado antes das alterações de OAuth.
O incremento de OAuth promoveu `9c3e01c957f2`; os incrementos seguintes passaram
por `1b9ea9a042e6` e chegaram ao motor `34d5ef8b73ad` da sequência 9, indicada acima.
Os ensaios Node com raízes de TEMP
excessivamente profundas encontraram `ENOENT` no lançamento de imagens de
270/291 caracteres; a chamada nativa `CreateProcessW` com o comando registrado
literal retomou a segunda instalação com sucesso. O ensaio completo posterior
usou uma raiz representativa e passou (331,5 s). Isso não certifica todos os
caminhos longos do Windows nem substitui a validação da distribuição pública.

A primeira distribuição é uma **Preview**, não uma declaração de perfeição ou
conclusão da meta geral. O serviço usa a branch `codex/update-service`, Node 22 e
raiz `deploy/updates`; a entrada foi corrigida para o carregador da Hostinger e
12 testes do serviço passaram. `/health` e o manifest Preview retornam 200;
`/ready` continua 503 porque ainda não há canal stable publicado. O manifest e os
instaladores da sequência 9 são válidos até 15/11/2026 e precisam ser renovados
antes dessa data. A chave privada e uma cópia local conferida ficam fora do
checkout/OneDrive; backup externo ainda não foi feito.

Downloads: [site oficial](https://cyara.com.br). Atualização atual:
[CUDIA Preview — sequência 9](https://github.com/victorccronemberger-blip/cudia/releases/tag/cudia-preview-20261016-seq9-34d5ef8b73ad),
com instaladores e pacotes normal/baseline. As fontes completas estão no snapshot
da branch `codex/preview-source`; a correspondência com os builds está descrita em
[SOURCE-PREVIEW-9.md](SOURCE-PREVIEW-9.md). A branch `main` permanece na base anterior.
Nesta máquina, a instalação está em `%LOCALAPPDATA%\Cudia Preview`, com `bin` no
PATH do usuário. Abra um CMD novo e execute `cudia`. Para conferir e aplicar
updates, use `cudia update --check` e `cudia update`.

## Tasklist operacional — estado atual

Incremento web e primeira execução publicado na Preview sequência 3 em 16/10/2026:

- [x] Expor `websearch` para qualquer provedor, sem flags de habilitação.
- [x] Compartilhar transporte MCP JSON/SSE entre V1/V2, com prazo total,
      limite de aquisição, cancelamento e erros explícitos do backend.
- [x] Neutralizar as descrições inspecionadas de pesquisa/leitura e a orientação
      residual de confirmação na skill web.
- [x] Validar 59 testes de fonte e cinco fluxos compilados por variante Windows.
- [x] Executar buscas reais pelo candidato: ChatGPT/Exa e Grok/Parallel,
      com `websearch` concluído e link de origem nas duas chamadas.
- [x] Promover o motor `886a9d61d490` no checkout, com backup e conferência dos hashes.
- [x] Publicar os dois ZIPs e os dois instaladores, conferir downloads públicos
      e ativar o manifest assinado sequência 3 na Hostinger.
- [x] Atualizar a instalação real de 2 → 3 por HTTPS, conferir versão/hash,
      executar busca Grok OAuth e confirmar que não há update pendente.

Critérios para um PC sem instalação anterior:

- [x] Iniciar o motor empacotado sem Git, Bun, Node ou .NET no PATH.
- [x] Conferir primeira execução com configuração, dados e credenciais vazios,
      sem herdar contas ou escolhas de modelo desta máquina, nas duas variantes.
- [x] Abrir a TUI com perfil vazio e PATH mínimo, expor `/connect` e encerrar normalmente.
- [x] Remover os pins pessoais DeepSeek/GLM do pacote; manter catálogos visíveis
      sem ativá-los por sua presença nos defaults. Credenciais e configurações
      explícitas continuam ativando provedores, inclusive endpoints locais sem chave.
- [ ] Validar login e seleção de modelo em uma instalação nova de Windows.
- [x] Implementar em fonte o navegador gerenciado Windows x64: Node portátil,
      pacote fixado e Chromium preparados no cache apenas na conexão explícita.
      Disponível na Preview pública sequência 5.
- [x] Validar o navegador gerenciado com cache vazio e PATH mínimo: download
      automático, JavaScript/clique, cancelamento com encerramento dos processos,
      primeira conexão concorrente, recuperação de instalação incompleta e reuso
      do cache sem novo provisionamento. Os testes de concorrência usam fixture;
      o download real interrompido e retomado foi validado separadamente.
- [ ] Certificar o reuso do navegador com a rede do SO desligada.
- [ ] Executar o instalador público e os fluxos principais em Windows limpo.
      Isolamento de perfil/PATH nesta máquina não substitui esse teste.
- [ ] Consolidar e publicar o snapshot completo dos fontes da distribuição;
      o tag-base atual não contém sozinho todas as mudanças locais registradas nos recibos.

Diagnóstico do provisionamento em 16/10/2026: o Bun embutido conseguiu instalar
o MCP fixado e baixar Chromium sem Node no PATH. Com a mesma CLI, navegador e
página local, a execução direta via Bun respondeu à inicialização e ao catálogo,
mas travou na navegação; via Node 22.23.3, completou navegação, JavaScript e clique,
encerrou com código zero e não deixou seus processos ativos. A integração em
desenvolvimento prepara automaticamente esse Node portátil, com SHA256 fixado
a partir do release oficial, e Chromium num cache próprio. Isso não exige uma
instalação manual de Node nem altera o PATH global. O diagnóstico não equivale
à qualificação em Windows limpo; essa mudança foi publicada na sequência 5.
Os testes de fonte e runtime embutido passaram: 16 de transporte/recursos Core,
25 de transporte/ciclo de vida/catálogo V1, sete de preparação e dois de processos
nativos Windows. Os dois pacotes passaram no typecheck e os quatro testes de
empacotamento passaram. O navegador V1 completou JavaScript/clique pelo CodeMode.
Um bundle do teste Core, executado pelo Bun do motor existente com PATH System32
e perfil/cache vazios, baixou as dependências e completou JavaScript/clique em
aproximadamente 30 segundos. O reuso validou 182 arquivos dos pacotes e 305 do
Chromium, sem mudar o recibo nem criar tentativa nova, em cerca de três segundos.
O ensaio de interrupção nativa usa instalador controlado com filho e descendente.
Um ensaio adicional interrompeu o download real do Chromium, confirmou o fim dos
dois processos instaladores e a ausência de recibo pronto; uma nova tentativa
completou navegação e clique. Esse ensaio usou o candidato `e8fe22954dae`, antes
da correção de ambiente e do resultado MCP; o ciclo de vida foi preservado.
Operação com a rede do SO desligada e Windows limpo ainda não foram certificadas.

Entrega sequência 5, motor `1b9ea9a042e6`: cada variante passou em seis fluxos
compilados, com 406 assertivas. O Core nativo completou navegação, atualização
explícita do catálogo, snapshot, clique e confirmação do JavaScript, com uma única
navegação e nenhum processo próprio restante. Uma instalação privada do ZIP
assinado repetiu esse fluxo pelos defaults distribuídos, sem configuração MCP
do usuário. O cache quente manteve tentativa e recibo idênticos. A correção MCP
preserva respostas concluídas quando chega `tools/list_changed`; a próxima
admissão aguarda atualização explícita, sem repetir a ação anterior.

Os dois instaladores e ZIPs públicos tiveram tamanho e SHA256 conferidos. A
Hostinger serve o manifest assinado sequência 5; a instalação principal atualizou
por HTTPS de 3 para 5, respondeu usando OAuth Grok e confirmou estar atualizada.
A sequência 4 permanece retirada, sem reaproveitamento. Os typechecks passaram
em 30 tarefas, sendo 28 em cache. O teste focado MCP passou em cinco cenários e
41 assertivas; naquela qualificação o arquivo completo ainda tinha cinco fixtures legadas a migrar:
três esperam negações removidas e duas aguardam eventos de aprovação que o serviço
permissivo deixou de emitir. Isso é dívida de testes explícita, não uma suíte verde.

Validação posterior nos fontes: as cinco fixtures MCP foram migradas para a
política atual, preservando identidade, exposição por sessão, invalidação e
desconexão. O arquivo completo passou em 21 testes e 157 assertivas. Os quatro
arquivos de Goal passaram em 34 testes e 183 assertivas; o cenário de planner e
verifier agora verifica os resultados fora do callback, para uma asserção não
ser absorvida como falha de provedor. Ambos os typechecks passaram. Esses ajustes
são de testes; não alteram os bytes da Preview sequência 5 já publicada.

Correção do contexto da instalação: a instalação inicialmente executada pelos
processos do Codex estava redirecionada pelo MSIX para a área privada do aplicativo.
O PATH persistente estava correto, mas um CMD externo não via o executável nem
pelo caminho completo. O caminho físico por handle confirmou o redirecionamento.
A árvore verificada foi copiada por um processo não empacotado para o destino
real anteriormente vazio, preservando a árvore anterior e as versões instaladas.
Uma segunda verificação sem identidade de pacote confirmou resolução de `cudia`
em CMD comum, versão, SHA256 do motor, caminho físico sem redirecionamento e
consulta HTTPS atualizada. A sessão em Crowtado foi aberta nessa instalação real.
Isso corrige a entrega nesta máquina; não substitui a qualificação em Windows limpo.

O ensaio posterior com marcadores exclusivos confirmou que a identidade de pacote
sozinha não basta: processos que retornavam `APPMODEL_ERROR_NO_PACKAGE` ainda
gravavam em `LocalCache`. Selecionar o processo do desktop Explorer como pai nativo
fez filho e neto gravarem no caminho físico esperado, sem elevação e sem depender
de uma janela de pasta aberta. A política desktop `0x4` com o próprio processo como
pai manteve o redirecionamento; essa flag sozinha não é uma correção geral.
Esse ensaio valida a transição de contexto, não uma nova instalação completa.
O instalador público sequência 5 ainda não incorpora uma transferência automática.

O protótipo em fonte incorpora o wizard Inno num iniciador Go e verifica o
contexto novamente no helper antes da preparação/finalização. Quatro testes
nativos do iniciador, `go vet`, testes de preparação e a suíte do cliente passaram.
O teste do instalador compilado foi interrompido antes de executar o Inno:
o Windows Defender bloqueou/quarentenou o novo executável. Isso não é êxito do
fluxo completo nem qualifica o protótipo para publicação. As configurações do
Defender e a instalação real em uso foram preservadas.

- [ ] Tornar a abertura do instalador por um processo MSIX independente do
      redirecionamento do chamador; validar automaticamente pelo Windows externo.
- [x] Exigir evidência do caminho físico e de um processo sem identidade de
      pacote ao qualificar a instalação para uso no CMD.

Carregamento de instruções — publicado na Preview sequência 6:

- [x] Desligar por padrão a promoção automática de documentos globais, do projeto,
      configurados e próximos dos arquivos lidos, tanto no V1 quanto no V2.
- [x] Permitir ativação explícita por `--load-instructions`, com escolha fora da
      configuração do projeto e do `.env`, transmitida ao worker da TUI antes
      do primeiro pedido. O alcance da escolha é o processo iniciado.
- [x] Preservar leituras normais e instruções fornecidas diretamente no pedido;
      documentos lidos continuam dados, sem anexos automáticos de outras regras.
- [x] Remover a orientação estética de evitar emojis do Explore e a referência
      genérica a permissões do lembrete inicial de Goal.
- [x] Expor `--context-audit` e `debug context --status` na CLI em fonte. A captura
      existente tem limites, hashes e origens observadas; não é tráfego de rede.
- [x] Validar 128 testes V1, 27 Core e três de prompts Goal; três skips Windows
      preexistentes. Ambos os typechecks passaram. CLI padrão/opt-in e transporte
      do worker real foram conferidos sem chamada ao provedor.
- [x] Compilar, testar os fluxos completos e distribuir essa mudança. Não altera
      retroativamente o histórico de sessões abertas nem as regras dos provedores.
- [x] Passar nove suítes compiladas e 639 asserções em cada variante normal/baseline;
      capturar pedidos reais contra provedor local de teste no V1/V2, padrão e opt-in.
- [x] Ativar o manifest assinado 6 em `cyara.com.br`, conferir downloads públicos e
      atualizar o Windows físico de 5 para 6. CMD, SHA256 e modo de instruções padrão
      foram conferidos fora do processo do Codex, sem encerrar sessões abertas.
- [x] Publicar a página de downloads e rotas que selecionam apenas artefatos de
      manifests válidos. 17 testes do serviço e verificação HTTPS pública passaram;
      o site distingue pacote de atualização de instalador disponível.

A auditoria motivadora conferiu uma sessão Grok 4.7 e vinculou por hashes a base
neutra e o adaptador xAI aos inputs do motor instalado. O projeto continha um
`AGENTS.md` com regras. Sem captura histórica da requisição, a afirmação do modelo
sobre “regras do produto” não comprova sua origem. O adaptador revisado não
acrescenta essa política; transformações não observadas e o serviço remoto
continuam fora dessa comprovação. Os testes legados de leitura de `.env` foram
migrados para a política permissiva anterior, mantendo asserções de conteúdo e
execução apesar de registros `ask/deny`; essa migração não reintroduz filtros.

Um ensaio controlado de interrupção também demonstrou que `Npm.add` pode aceitar
uma pasta parcial e deixar `Arborist.reify` escrevendo após liberar o lock. O
provisionamento novo precisa de um subprocesso cujo encerramento seja aguardado
antes da liberação, além de publicação atômica de um recibo de prontidão. A
correção geral de `Npm.add` permanece uma dívida separada deste incremento.

Correção da primeira execução: o ensaio inicial da Preview sequência 2 apresentou
nove provedores como conectados sem credenciais. A origem dos defaults agora fica
em metadados internos, fora da configuração pública/persistida. Overrides do usuário
ou projeto mantêm sua precedência. A correção passou em 113 testes de configuração,
121 de provedor/HTTP (um skip preexistente), 17 de catálogo/configuração Core e quatro
de empacotamento. Cada variante do motor `886a9d61d490` passou nos seis fluxos
compilados, incluindo o perfil vazio com o ZIP real. A execução interativa também
abriu o seletor de conexão e encerrou com código zero; não foi um teste em VM.

Concluído e validado nos incrementos anteriores:

- [x] Base operacional neutra no modo enxuto e descoberta de skills sem catálogo fixo.
- [x] Goal com planejamento, execução incremental e verificador independente.
- [x] Arena explícita com quatro candidatos independentes; a política atual permite ferramentas aos candidatos.
- [x] Pesquisa/leitura da web e navegador com JavaScript e cliques sob demanda.
- [x] Compactação automática V1/V2, checkpoint ampliado e compactação manual V2.
- [x] Busca global de conversas por título e comandos de retomada.
- [x] MCP V2 com descoberta e exposição por sessão, recursos/templates e OAuth.
- [x] Leitura limitada e paginada, recuperação de resultados e detecção de alterações.
- [x] Limites de aquisição de instruções, erros visíveis e recuperação após reparo.
- [x] Integração de projetos, arquivos, busca e operações Git da interface V2.
- [x] Builds Windows de teste e launchers verificados nos incrementos já encerrados.

Incremento de origem do contexto nativo, concluído e validado:

- [x] Manifest de origem junto ao texto-base e às atualizações duráveis do V2.
- [x] Auditoria versão 2 com hashes, posições, estados de validade e orçamento de metadados.
- [x] Migração preservando registros antigos, replay e testes de contexto indisponível.
- [x] Compatibilidade de leitura das capturas antigas da auditoria.
- [x] Suíte integrada atual: 224 testes Core, 51 V1 e 49 testes de LLM passaram.
- [x] Concluir o fluxo compilado de origem com reinício, remoção e compactação.
      A expectativa do teste agora confere as atualizações no wrapper de usuário
      realmente emitido pelo adaptador, preservando a fronteira da auditoria.
- [x] Validar sete fluxos em cada variante Windows, fechar revisão independente e
      conferir assinatura/launcher da nova compilação. A promoção posterior está registrada abaixo.

Próximos trabalhos da meta geral:

- [x] Entregar instalador Preview e comando `cudia` no PATH do usuário,
      preservando a pasta atual e dispensando Git/Bun para iniciar o pacote instalado.
- [x] Entregar consulta e aplicação de atualizações Preview pelo serviço em `cyara.com.br`,
      com arquivo de conexão, releases assinadas, instalação por versão e recuperação.
- [ ] Completar proveniência dos hooks/plugins V1 e transformações dos adaptadores.
- [x] Rastrear as transformações observadas de mensagens, sistema e instruções
      dos plugins nas chamadas principais V1, fora do prompt e com omissões explícitas.
- [x] Remover seleção residual de editores pelo nome do modelo e neutralizar suas descrições.
- [ ] Concluir auditoria do catálogo restante e da disponibilidade dos backends web.
- [x] Neutralizar as prescrições inspecionadas nas descrições de shell, glob,
      tarefas, listas de trabalho e skills; preservar seus contratos técnicos reais.
- [ ] Mapear corpos carregados por ferramentas e linhagem dos resumos/retomadas.
- [ ] Completar limites de recursos e formatos das APIs públicas de arquivos e avaliar poda adicional.
- [ ] Melhorar acompanhamento, mensagens e interrupção dos agentes.
- [x] Preservar a identidade pedida na retomada de task: lookup com erro, defeito
      ou interrupção não cria silenciosamente outra sessão.
- [x] Isolar o estado mutável do GitLab Workflow por sessão e chamada, com
      continuidade remota, descarte e testes de interleaving; remover junto o
      caminho residual de aprovação baseado em regras legadas.
- [ ] Completar operações MCP e compatibilidade restante da interface V2.
- [x] Implementar consultas LSP nativas V2 sob demanda, com processos e recursos limitados.
- [x] Implementar diagnósticos explícitos push/pull, notificações e status HTTP/interface em fonte e testes locais.
- [x] Validar e promover diagnósticos explícitos LSP e a política atual nas duas variantes Windows.
- [x] Integrar diagnósticos LSP automáticos após escrita, com prazo e saída limitados.
- [ ] Concluir auditoria de instruções ambientais, hooks/plugins e capacidades residuais à luz da nova política.
- [ ] Implementar aceleração FFF com garantias de atualização, filtros e limites.
      A busca pública usa Ripgrep por requisição.
- [x] Corrigir glob/grep e validar resultados completos,
      arquivos novos/alterados, regex, filtros, caminhos literais e limites visíveis.
- [ ] Consolidar continuidade após interrupções sem repetir operações de resultado incerto.
- [ ] Expor consumo real/estimado por tarefa e agente e evoluir os limites do Goal.
- [ ] Concluir disputas de cancelamento e isolamento ainda abertas nas integrações.
- [ ] Integrar agendamento/notificações quando explicitamente solicitados.
- [x] Promover o build validado ao diretório padrão após a saída da sessão antiga;
      conferir ambas as variantes e manter backup do executável anterior.

A sessão antiga do PID 9764 terminou sem intervenção do agente. O diretório padrão
recebeu o build validado `b5c826d1a160`; o incremento posterior de busca promoveu
`29be8f8233dd`, também com backup verificado do executável anterior. O incremento
de consultas LSP promoveu depois `7b1cb2b7c080`, com a mesma verificação.
Esta lista não declara equivalência com o Codex nem conclusão da meta geral.

Entrega de distribuição solicitada em 15/10/2026:

- [x] Confirmar domínio informado pelo operador: `https://cyara.com.br`.
- [x] Inspecionar a implantação da Hostinger: Node.js 22, npm, `server.js`,
      branch `main` e raiz `./`. O build falhou em `npm install` porque o
      monorepositório Bun usa dependências `catalog:` incompatíveis com npm.
- [x] Definir serviço independente em `deploy/updates`, com pacote npm próprio,
      sem alterar o gerenciador ou as dependências da raiz do projeto.
- [x] Inventariar a fronteira do pacote: iniciar o executável compilado diretamente,
      preservar a configuração do projeto e separar os defaults distribuídos dos
      diretórios graváveis. O launcher de desenvolvimento depende de Git/Bun e
      não serve como launcher do instalador. A cópia distribuída de `tui.json`
      deverá excluir a referência ao plugin de smoke antes de omitir seus arquivos.
- [x] Implementar e validar o serviço de manifests assinadas e o publicador local
      por substituição atômica. Onze testes passaram em cópia limpa com Node.js 22;
      `npm ci` não depende do monorepositório. O servidor iniciado pela CLI
      respondeu saúde 200 e disponibilidade 503, como esperado sem uma release.
      Isso não declara o instalador, o atualizador ou uma publicação em produção.
- [x] Configurar a raiz `deploy/updates` na Hostinger e publicar o serviço pela
      branch `codex/update-service`, com implantação automática conferida.
- [x] Empacotar motor, agentes, skills e configurações necessários; separar arquivos
      distribuídos de sessões, credenciais e preferências do usuário.
- [x] Implementar wizard por usuário, desinstalação e entrada idempotente no PATH;
      verificar instalação/reexecução/remoção com motor real e Registro isolado.
- [x] Fechar limpeza dos auxiliares, recibos, locks e metadados próprios;
      validar 16 retomadas compiladas após quedas sem defers pelos comandos registrados.
- [x] Validar visualmente cancelamento, destino, tarefa de PATH e conclusão em
      português numa fixture CUDIA TEST; executar de outra pasta e conferir remoção.
- [ ] Validar Windows limpo e o perfil de produção antes de entregar o instalador final.
- [x] Implementar o backend de preparação/commit/abort sem ativação antecipada,
      leases de execução e remoção inventariada com recuperação após falha.
- [x] Implementar propriedade conservadora da entrada no PATH; verificar em chaves
      HKCU isoladas, preservando tokens, tipo, entradas preexistentes e casos ambíguos.
      O wizard compilado usa esse backend; os testes não alteram o PATH real.
- [x] Implementar launcher que mantenha argumentos, código de saída e diretório
      de trabalho, inclusive pastas com espaços e caracteres não ASCII.
- [x] Implementar arquivo de conexão apontando para
      `https://cyara.com.br/updates/v1/stable.json`, com canal e política de consulta.
      A chave pública confiável pertence ao atualizador instalado: o endereço
      configurável não pode substituir silenciosamente a raiz de confiança.
- [x] Verificar assinatura, sequência de release, compatibilidade, tamanho e SHA-256
      antes da ativação; manter a versão funcional em caso de falha ou indisponibilidade.
- [x] Testar download interrompido, instalação concorrente, retomada/rollback,
      funcionamento offline e atualização com uma sessão antiga ainda aberta.
- [x] Validar consulta automática na abertura interativa sem esperar a resposta;
      intervalo padrão de 24 horas, novas conexões habilitadas e preservação da
      política existente. Consulta não aplica updates; sessão aberta não agenda timer.
- [x] Validar rollover A → A+B → B com launchers reais, mantendo o bootstrap fixo;
      conferir rejeição antes/depois da transição e preservação da ativação em falhas.
- [ ] Implementar manutenção do bootstrap e retenção de versões respeitando
      sessões abertas. Hoje não há coleta automática; o estado aceita
      até 128 registros e 8 MiB, com falha explícita ao exceder os limites.
- [ ] Provisionar dependências opcionais do bridge Claude em diretório gravável e
      revisar comandos que ainda pressupõem um checkout de desenvolvimento.
- [x] Validar atualização Preview real por HTTPS, sequência 1 → 2, seguida de
      inferência pelo motor atualizado e nova consulta sem update pendente.
- [ ] Validar o instalador em ambiente Windows limpo. Assinatura de release Ed25519
      e certificado Authenticode são mecanismos distintos; não declarar assinatura
      do executável sem certificado e verificação reais.

A Hostinger distribuirá metadados públicos de releases. Esse serviço não recebe
prompts, conversas, chaves de provedores ou contexto dos projetos. Uma alteração
de código não vira atualização automaticamente: é necessário construir, validar,
publicar os artefatos e publicar a manifest correspondente. O cliente de atualização
explícita e o wizard compilado estão validados localmente com destinos isolados.
Windows limpo e qualificação stable continuam pendentes; a publicação HTTPS Preview
e sua chave estão registradas na primeira entrega acima. A QA interativa isolada
foi concluída no incremento registrado abaixo.
A arquitetura foi consultada pela skill
`codex-advisor`; a implementação e os testes têm critérios próprios de conclusão.
Os requisitos de integrações continuam explícitos: operações Git precisam de Git;
o MCP Playwright gerenciado prepara suas próprias dependências no Windows x64,
e o bridge Claude usa Node e Claude CLI preparados separadamente. Isso não deve
impedir iniciar o harness com um motor já empacotado.

## 1. Contexto enxuto e diagnóstico

- [x] Política única de contexto para V1 e V2, com modo padrão preservado fora
      dos launchers CUDIA e opção explícita de compatibilidade.
- [x] Descoberta de skills sem catálogo fixo no modo enxuto.
- [x] Orientação MCP consultada sob demanda no CodeMode V1.
- [x] Base neutra para agentes sem prompt próprio no modo enxuto.
- [x] Captura optativa do contexto preparado, separando metadados de texto.
- [x] Busca global de conversas por título, com limite e formato JSON compatível.
- [x] Validar o envio após hooks, diferenças de tamanho, isolamento de dados e
      manutenção das permissões nos caminhos afetados.
- [x] Revisão independente e binários Windows de teste em `dist-cudia-preview`,
      normal e baseline, com assinatura de fontes e launcher PowerShell verificados.
- [x] Promover a cópia validada ao diretório padrão depois de confirmar a saída
      da sessão antiga, verificar abertura exclusiva e guardar o binário anterior.
      Normal e baseline passaram pelo launcher padrão de outra pasta, sem Bun no PATH.

A captura observa a requisição preparada antes do adaptador do provedor. Não é
um registro do tráfego final nem revela instruções internas do serviço. Plugins,
adaptadores e provedores continuam sendo camadas a identificar. Histórico antigo
pode conservar instruções até uma nova sessão ou compactação adequada.

## 2. Ferramentas e coordenação

- [x] Inventariar ferramentas existentes e identificar falhas observáveis de
      busca, leitura, edição, shell, processos em segundo plano e resultados grandes.
- [ ] Aplicar limites de saída e retenção, manter cancelamento e apontar para o
      resultado completo quando houver truncamento.
      Primeiro incremento: limitar respostas grandes de grep e notificações de
      tarefas em segundo plano. O read agora verifica contenção canônica,
      autorização por instrução e entrega antes de deduplicar. Lotes automáticos
      de instruções têm envelope de 16 KiB e oito documentos; documentos que não
      cabem sozinhos geram erro explícito. Leitura exata paginada permanece
      disponível nos caminhos V1 e V2. O pager V2 recupera texto retido, dados
      estruturados e conteúdo persistido com hash e orçamento após serialização.
      As ferramentas de leitura V1/V2 agora medem a resposta completa e usam
      enumeração limitada, páginas exatas e snapshots de diretório. Ainda faltam
      os caminhos públicos de arquivos da interface e progresso garantido com conjuntos de instruções maiores
      que o contexto selecionado. O Goal foi verificado:
      continuações incrementais e instruções completas preservadas.
- [x] Descobrir agentes por metadados no V1 em vez de repetir um catálogo ilimitado
      no modo enxuto, preservando a autorização nativa da delegação.
- [ ] Melhorar mensagens, acompanhamento e interrupção de agentes sem acionar
      competições automaticamente. Arena continua explícita e com quatro candidatos.
- [ ] Completar MCP V2 usando o registro e a autorização canônicos do Core.
      Transporte local/HTTP, descoberta explícita e exposição por sessão foram
      implementados. Conectar não injeta o catálogo no contexto. OAuth usa agora
      Integration/Credential canônicos. API e controles administrativos de conexão
      agora compartilham o runtime do Core. Recursos e templates têm descoberta
      paginada e leitura explícita pela ferramenta nativa. Ainda faltam demais
      operações administrativas e a compatibilidade integral da interface
      com o servidor V2. O CodeMode e os controles legados continuam V1.
- [x] Consolidar listagem, conexão, desconexão e OAuth explícito da interface
      V2 com o Core, sem fabricar contexto de ferramenta ou expor catálogos ao modelo.
- [x] Descobrir recursos e templates MCP V2 sob demanda, com snapshots de catálogo,
      leitura de URI exato, autorização nativa e descarte de respostas invalidadas.
- [x] Conectar a listagem de projetos e os seletores de pasta ao cliente canônico
      V2, com caminhos reais do servidor e invalidação do cache após falhas de leitura.
- [x] Conectar árvore, leitura e busca de arquivos da interface ao transporte V2,
      preservando caminhos literais, cancelamento e separação entre projetos.
- [x] Corrigir limites de paginação de mensagens V2, separando a janela de histórico
      de cada página HTTP e preservando o comportamento V1 de limite zero.
- [x] Consultar arquivos com uma nova varredura por pedido, aguardando seu fim e
      rejeitando resultados parciais ou acima do orçamento, sem depender de watcher.
- [x] Servir informações, status e diferenças Git pelo Core V2, com caminhos
      relativos à pasta selecionada e modos local/branch verificados na interface.
- [ ] Corrigir os demais caminhos da interface com servidor V2. Ainda há chamadas
      antigas em `pages/layout.tsx` para recuperação de diretórios associados a
      projetos. As consultas VCS que retornavam 404 foram implementadas e validadas.
      Catálogo de provedores,
      agentes e seleção do modelo padrão usam o cliente canônico.
      Links de servidor montados manualmente com base64 terminado em `==` ainda
      podem causar erro; os links sem padding gerados pela interface funcionam.
      A árvore de pastas específica do desktop ainda precisa de validação visual.
      A visibilidade de falhas de rede e a repetição pelo seletor também precisam
      de validação visual. A interface reconhece a ausência de LSP nativo V2 e
      evita as consultas legadas; implementar o serviço nativo continua pendente.
      Os metadados de arquivos ignorados também não são fornecidos pelo contrato V2.
      A busca agora encontra arquivos criados após a inicialização; a descoberta
      de diretórios vazios permanece limitada. Glob/grep públicos agora usam
      Ripgrep por requisição; aceleração nativa FFF permanece pendente.
      Custos ausentes ainda viram zero na projeção legada da interface;
      distinguir preço desconhecido exige adaptar esse contrato e seus consumidores.
      Esses resultados não invalidam os testes específicos do MCP,
      mas impedem declarar a interface inteira pronta.

## 3. Continuidade e orçamento

- [ ] Mapear a origem de cada bloco de contexto, incluindo plugins e retomadas.
      O contexto nativo V2 agora mantém manifests junto ao texto-base e às
      atualizações duráveis, com arquivos, metadados de skills/referências,
      produtor e fase. Ainda faltam hooks V1, transformações posteriores do
      adaptador, corpos carregados por ferramentas e linhagem dos resumos.
- [x] Limitar a aquisição de instruções ambiente V1/V2 por fonte, lote e candidatos,
      com deadline para corpo remoto V1, erros explícitos e preservação do snapshot
      nativo já admitido quando uma observação fica indisponível. Isso não conclui
      o inventário de proveniência nem estabelece paridade de URLs no V2.
- [ ] Recuperar objetivo e estado depois de interrupções, sem repetir
      automaticamente operações externas cujo resultado seja desconhecido.
- [ ] Expor consumo informado pelo provedor por tarefa e agente; distinguir
      contagem real, estimativas e campos indisponíveis.
- [ ] Evoluir o Goal com limites verificáveis e critérios claros de conclusão.
- [ ] Integrar agendamento e notificações somente quando solicitados, com estado
      persistente e sem chamadas periódicas ao modelo para verificar fatos locais.

## 4. Compactação e navegação — prioridade acrescentada pelo operador

- [x] Reutilizar compactação automática V1/V2, sem adicionar outro provedor.
- [x] Ampliar o checkpoint sob demanda para escopo, permissões, evidências,
      artefatos e operações com resultado desconhecido; preservar cauda recente.
- [x] Melhorar referências de recuperação no V1: marcadores conservam IDs da
      mensagem e parte; `tool_result` lê páginas autorizadas do texto gravado,
      com limite após serialização e detecção de alteração entre páginas.
      A poda usa evento durável e não substitui a saída por um snapshot antigo.
- [ ] Habilitar poda adicional somente após consolidar os demais limites de saída;
      o launcher continua com `compaction.prune: false`.
- [x] Expor pesquisa nativa também a modelos personalizados pelo launcher,
      mantendo leitura HTTP e permissões existentes.
- [x] Validar busca e leitura pelos caminhos afetados, incluindo limites de entrada.
- [x] Expor compactação manual no V2 usando coordenação canônica, sem competir
      com uma execução ativa nem fabricar replay de operações externas.
      Resumo sem ferramentas, fila no processo atual, preservação dos passos e
      checkpoint anterior em caso de falha ou resposta incompleta. Fila manual
      não é retomada automaticamente após reiniciar o processo.
- [x] Preservar limites de compactação em configurações que misturam provedores
      V1 com `keep.tokens`/`buffer` do V2, respeitando precedência explícita.
- [x] Resolver o caminho do banco ao abrir o runtime e validar isolamento entre
      bancos sucessivos, com limpeza dos testes compatível com SQLite no Windows.
- [x] Integrar navegador com renderização e cliques sob demanda, confirmado pelo
      operador. Playwright MCP fixado e inicialmente desativado no V1; conectar
      por ferramenta sem catálogo fixo, com permissões nativas.
- [x] Testar navegador real contra uma página local com JavaScript e clique,
      e confirmar encerramento de processo interrompido durante a inicialização MCP.
- [x] Portar o transporte do navegador ao Core V2 e validar JavaScript e clique
      com Playwright real. A exposição usa o registro canônico por sessão;
      OAuth de MCP V2 usa autorização explícita do operador pelas APIs de integração.
- [x] Implementar OAuth MCP no Core com PKCE, estado/emissor, callback local
      compartilhado e credenciais canônicas, sem autenticação ou replay automático
      depois de um erro RPC. Validar revogação, prioridade de cabeçalhos explícitos,
      redirecionamentos OAuth e limites de respostas em servidores locais reais.
- [x] Persistir a proteção de renovação OAuth do Core entre reinícios: registrar a
      tentativa antes da chamada, concluir por posse e snapshot, preservar o
      registro em falha, e recuperar somente por nova autorização explícita.
      Validado com processos independentes, encerramento forçado e falha de commit.
- [ ] Validar deterministicamente disputa de cancelamento após posse do commit,
      contagem de eventos e isolamento entre Locations durante alterações de integração.

## Evidência para concluir

Cada incremento precisa de implementação, verificações focadas, revisão das
permissões afetadas e documentação das limitações. A revisão do advisor orienta
decisões; não substitui resultados observados. O motor permanece baseado no
OpenCode nesta etapa. A avaliação de outro motor é uma decisão separada.

Na fixture de preparação com 15 skills e descoberta MCP, o contexto fixo mais as
mesmas definições de ferramentas passou de 15.079 para 4.604 bytes. A diferença
foi 10.475 bytes; as definições das ferramentas estão incluídas nos dois lados.
Essa medição não inclui o histórico e não representa tokens, tráfego final ou
uma economia garantida para todo projeto/modelo. O teste está em
`packages/opencode/test/session/harness-context.test.ts`.

As verificações cobrem execução V1 AI SDK/nativa e V2, alteração de instruções
por plugin no caminho OAuth, permissões e descoberta, recuperação global de
sessões, concorrência e falha de gravação da auditoria. Não medem a qualidade
intelectual do modelo nem demonstram equivalência com o Codex.

No incremento de compactação manual V2, passaram 189 testes do Core, 35 de
compatibilidade de configuração e 5 do SDK embarcado. A verificação de tipos
passou em Core, OpenCode, Server, Protocol, Client e SDK Next. Os binários Windows
normal e baseline também passaram no fluxo HTTP real de geração, checkpoint manual
e continuação usando o checkpoint, com o histórico original ainda consultável e
exatamente três chamadas ao provedor simulado local por execução. Os testes não
consumiram uma API paga.

No incremento MCP V2, passaram 227 testes combinados do Core, incluindo registro
por sessão, schemas JSON exatos, permissões nativas, compactação e coordenação.
A verificação focada final do gerenciador passou nos 16 testes, com 97 assertivas:
inclui interrupção da paginação após o prazo total e isolamento de autorizações
lembradas para `prod`/`PROD` e `echo`/`ECHO` no Windows. O navegador real passou
em renderização JavaScript e clique por referência observada; o SDK embarcado
passou em seis testes. Os tipos passaram nos pacotes afetados Core, OpenCode,
Server, SDK Next, TUI e App.

Os binários normal e baseline passaram, cada um, nos dois fluxos HTTP compilados
(30 assertivas por variante): compactação manual e conexão/pesquisa/exposição/
chamada MCP, sem expor a ferramenta para uma segunda conversa. As chamadas de
modelo e MCP desse teste usam servidores locais simulados. A revisão independente
com Astra identificou e orientou correções de prazos e identidade de permissões;
Luna executou subtarefas delimitadas. Não foram medidos custos ou economia dos modelos.
Cancelamento durante registro parcial e exclusão durante uma chamada remota ativa
ainda precisam de testes específicos; a interface de permissão foi verificada
por código e tipos, sem validação visual.

A cópia de teste atual está em `dist-cudia-preview`, versão
`1.18.35+cudia.a1c9471a1874.2d70594956c6`, com assinatura de fontes
`2d70594956c6f2089a62645c16a1ee64567cb224`. O launcher PowerShell 5 foi validado
para ambas as variantes com um PATH sem Bun. O executável antigo em uso e sua
sessão permaneceram preservados; não houve promoção ao diretório padrão.

No incremento OAuth MCP, a bateria principal passou em 76 testes e 390 assertivas,
incluindo transporte, gerenciador, registro canônico, callback local e integrações.
A verificação final de Integration passou em 19 testes e 73 assertivas após corrigir
também o horário de emissão em renovações de tokens curtos. Outros 67 testes
cobriram credenciais, configuração, provedores OpenAI/OpenCode e compactação;
24 cobriram pesquisa e leitura HTTP. O navegador real voltou a passar em JavaScript
e clique. Passaram ainda 35 testes de compatibilidade V1/V2, seis do SDK embarcado
e seis de contratos Schema. Um erro de caminho Windows no teste de contratos foi
corrigido usando conversão de URL para caminho nativo.

As duas variantes compiladas passaram, cada uma, em três fluxos HTTP com 55
assertivas: compactação, exposição MCP por sessão e OAuth explícito pela API de
integrações. No último, a chamada remota retorna 401 depois de produzir um efeito;
há exatamente uma chamada e nenhuma troca automática de token. Os testes do Core
cobrem também respostas 403/404, prioridade de Authorization configurado mesmo com
credencial gerenciada expirada, revogação, redirecionamentos e resposta OAuth
excessiva. Descobrir uma integração não inicia autenticação nem injeta seu catálogo.

Os tipos passaram em Core, Schema, OpenCode, Server, Protocol, Client, SDK Next,
TUI e App; os clientes foram regenerados pelos scripts oficiais do repositório.
A revisão independente usou Astra com esforço `high`; subtarefas delimitadas
usaram Luna com esforço `high`. Permanecem as verificações de disputa e isolamento
listadas acima e a consolidação administrativa MCP. Este incremento não encerra
a meta geral.

No incremento de recuperação de renovação OAuth, passaram 65 testes com 383
assertivas de credenciais, Integration e MCP, além de 41 testes com 127 assertivas
de migração, processos independentes e provedores OpenAI/OpenCode. Os dois testes
de recuperação encerram somente processos Bun criados pela fixture: o primeiro
após o servidor receber a renovação; o segundo falha ao gravar uma resposta já
recebida. Reabrir o banco não repete a chamada. Uma validade estendida por alteração
genérica também não elimina o registro; a substituição explícita cria outra
credencial e permite recuperar a conexão. O SDK embarcado passou em seis testes,
e os tipos passaram em Core, OpenCode e Server.

Os binários normal e baseline passaram novamente nos três fluxos HTTP e nas 55
assertivas por variante. O fluxo OAuth compilado agora entrega um acesso expirado,
exige exatamente uma renovação e usa o acesso sucessor no MCP. Após a falha 401 da
chamada remota, não há nova renovação nem repetição. A assinatura das fontes e o
launcher PowerShell 5 sem Bun no PATH foram conferidos depois dos testes.

A migração acrescenta somente uma coluna privada, sem mudar o valor das credenciais
antigas ou os contratos públicos. O gerador e sua verificação agora funcionam no
Windows com separadores nativos. O banco usa WAL/FULL para confirmar o registro
antes do envio. Em uma medição local de 50 ciclos de criação, posse e conclusão
(150 transações, preparação excluída), NORMAL levou 73,24 ms e FULL 155,31 ms.
É uma observação desse computador e desse trabalho, sem garantia geral de latência
ou teste de queda de energia. Caminhos legados que ignoram o registro continuam
fora da garantia de não repetir renovações. Uma leitura concorrente iniciada antes
da posse pode terminar; a posse atômica continua impedindo uma segunda renovação.

Pendência operacional: a revisão automática rejeitou, por política local, a limpeza
dos quatro arquivos SQLite fictícios em
`%USERPROFILE%\AppData\Local\Temp\cudia-refresh-benchmark-YJJYrl`.
Não contêm credenciais reais. A remoção recursiva e a remoção por caminhos exatos
foram rejeitadas; não foi usado outro mecanismo para contornar a decisão.

No incremento administrativo MCP, passaram 50 testes com 255 assertivas no Core,
sete com 47 no SDK embarcado, 16 com 75 no Client, seis com 15 nos contratos Schema
e 31 com 66 na interface. O teste de disputa suspende a leitura real da sessão
depois de `tools/list`, invalida a conexão por evento de credencial e exige falha
na inicialização. A versão com a checagem na ordem antiga foi rejeitada pelo mesmo
teste; a correção mantém a checagem final imediatamente antes da publicação.

A API foi verificada com autenticação, isolamento entre pastas, 404 para servidor
não configurado, resposta 204 e descoberta sem RPC. O health canônico agora inclui
`protocol: "v2"`, distinguindo-o da resposta transitória V1. A precedência de V1 em
servidores híbridos permanece coberta. Os dois clientes foram regenerados pelos
scripts oficiais; os tipos passaram nos pacotes afetados e o build de produção
da interface passou. O cliente nativo adicional resolveu para o pacote local e
foi incluído com sucesso no bundle real, preservando o cliente antigo dos demais
caminhos da interface.

O teste visual usou `agent-browser` em sessão própria e servidores locais isolados.
Conectar o servidor simples não iniciou OAuth. O desafio de autenticação mostrou
uma ação explícita; autorizar produziu uma única troca de token e deixou a ação
de conectar separada, sem inicializar o MCP protegido. Conectar e desconectar
depois funcionaram pela API canônica. Fechar outra tentativa retornou 204 no
cancelamento e não aumentou a contagem de tokens. Não houve consulta ao catálogo
de recursos V2. A proteção de conclusão tardia da janela foi revisada por código,
sem teste determinístico de componente; a janela mostra uma falha após seu limite
de aproximadamente dois minutos, antes da expiração de dez minutos do servidor.

As variantes Windows normal e baseline passaram, cada uma, nos três fluxos HTTP
compilados e em 73 assertivas. Esses fluxos agora incluem controles administrativos,
conexão compartilhada com ferramentas do agente e reconexão explícita depois do
OAuth. O launcher PowerShell 5 passou para ambas a partir de outra pasta, sem Bun
no PATH. A assinatura foi conferida após os testes. A cópia CLI de teste não embute
a interface web; o bundle da interface foi validado separadamente. O executável
antigo em uso permanece preservado.

A revisão independente deste incremento usou Astra com esforço `high`; as duas
subtarefas delimitadas usaram Luna com esforço `high`. Foi corrigida uma disputa
real de publicação da conexão; um apontamento sobre o fim da consulta OAuth foi
retirado depois da apresentação do trecho que já mostrava a falha na tela. A meta
geral continua ativa, com as pendências acima; não houve medição de economia ou
equivalência de inteligência com o Codex.

A verificação final também passou no navegador Playwright real pelo adaptador
MCP do Core (JavaScript e clique por referência observada) e em 15 testes com
60 assertivas de pesquisa/leitura HTTP. A verificação de tipos da interface foi
forçada novamente, sem reaproveitar apenas o cache incremental. Os processos de
QA criados para este incremento foram encerrados; as fixtures locais foram
preservadas como evidência e o processo antigo do operador continuou em execução.

No incremento de descoberta de agentes e recuperação V1, passaram 49 testes com
210 assertivas de metadados, paginação e projeção; 55 testes com 172 assertivas de
compactação; e 94 testes com 334 assertivas de Goal, instruções e leitura. O Core
passou em 48 testes com 89 assertivas de eventos e projeção condicional, incluindo
rollback sem notificação, exclusão, versões divergentes e preservação de campos
opacos. O contrato de eventos passou em dois testes com 25 assertivas; o novo
evento V1 fica fora do contrato atual do Protocol. Os clientes foram regenerados
pelos scripts oficiais e os tipos passaram em Core, Schema, OpenCode, Server,
Client, SDK legado, TUI e App.

A fixture com todas as definições de ferramentas mede 23.587 bytes no modo enxuto
tanto com três como com 120 agentes. Comparado ao catálogo padrão anterior, sem
as duas novas ferramentas, são 1.216 bytes adicionais com três agentes e 7.004
bytes a menos com 120. As definições novas custam 1.423 bytes nessa fixture. Não
são contagens de tokens nem economia garantida para qualquer catálogo.

Permanece um teste de symlink de arquivo pulado no Windows por possível falta de
privilégio; a verificação de escape por junção de diretório executou e passou.
O teste de carregamento de instruções por URL continua como TODO, e há também o
skip existente do projetor V2 em um teste legado de compactação. Um teste antigo
de cancelamento com limite de 250 ms falhou sob carga com 312 ms; a suíte completa
de compactação passou na repetição, sem alteração desse limite. Os testes de Goal
cobrem reidratação após compactação, sem simular reinício literal de processo.

A revisão independente usou `gpt-6-astra` com esforço `high`; a consulta de
arquitetura usou `gpt-6-astra` com `medium`, e tarefas delimitadas usaram
`gpt-6-luna` com `high`. Nenhuma falha nova foi identificada na revisão dos trechos
fornecidos; isso não substitui a execução das verificações. Ambas as variantes
Windows passaram nos três fluxos HTTP compilados, com 73 assertivas por variante,
e no launcher PowerShell 5 sem Bun no PATH. As fontes foram conferidas antes de
gravar a assinatura da cópia de teste. O limite agregado das instruções anexadas
pelo read permanece pendente e a poda adicional continua desativada; a meta geral
permanece ativa.

A checagem global de espaços do índice também aponta linhas com espaços finais
em patches já presentes de Groq, OpenAI e xAI. Os arquivos deste incremento
passam na checagem delimitada; os patches existentes foram preservados, pois
alterar texto de um patch exige verificar novamente sua aplicação.

No incremento de leitura paginada, o `read` ganhou páginas de texto exato com
envelope JSON de até 6.000 bytes, offsets UTF-16, hash e preservação de linhas
longas. A leitura percorre o arquivo inteiro para calcular o hash de cada página,
mas conserva apenas a janela solicitada. Lotes automáticos de instruções têm
limite de 16 KiB, ou o limite configurado se menor. Um documento que não cabe
sozinho retorna erro explícito, em vez de sugerir paginação automática indefinida.
O tamanho observado da entrada também tem uma verificação conservadora antes de
ler o corpo. Essa verificação por `stat` não é um snapshot imutável do arquivo.

Recibos novos só deduplicam instruções completas em mensagens selecionadas para
o modelo. A revisão independente identificou que reidratar partes do banco podia
creditar conteúdo omitido do contexto; essa reidratação foi removida. Os testes
com requisições reais a um provedor local verificam a entrega completa, repetição
sem duplicação e nova entrega após remoção do contexto ou erro da resposta.
As asserções de compatibilidade de resultados antigos permanecem limitadas aos
metadados históricos. Não há garantia de progresso se o conjunto de instruções
exige mais contexto que o modelo consegue conservar, nem limite total novo para
saídas normais de arquivos, diretórios ou instruções globais/da raiz.

A interface V2 usa o cliente local gerado para agentes e catálogo. Ela lê
`request.body` e consulta `GET /api/model/default`, com autenticação e escopo por
pasta, em vez de depender dos campos e rota do cliente antigo. Datas inválidas
ficam vazias. O teste visual em `agent-browser` verificou o modelo configurado
selecionado apesar de existir outro com lançamento mais recente, e navegação até
uma sessão carregou o agente sem a exceção de `temperature`. Não houve geração.
Nessa etapa ainda estavam abertos `/api/project` 404, seleção de pasta e preço desconhecido
convertido em zero pela projeção legada.

O primeiro teste dos binários detectou também uma disputa de inicialização: a
primeira consulta retornava o modelo de fallback antes de aplicar a configuração;
consultas seguintes retornavam o modelo correto. Uma reprodução independente
confirmou o comportamento nas duas variantes, sem perda da migração V1. A abertura
da Location passou a aguardar o registro interno e o commit do lote, mantendo
refreshes e carregamento de plugins externos nos caminhos assíncronos existentes.
Essa espera pode aumentar a latência da primeira abertura; no executável, o
catálogo inicial usa cache ou snapshot embarcado. Em execução pela fonte sem
nenhum dos dois, o carregamento pode fazer a consulta HTTP já existente.

A regressão de inicialização usa `Deferred` no carregamento do catálogo e disputa
os sinais de inicialização e publicação, sem espera por tempo. Restaurar o fork
antigo fez o teste falhar: o catálogo era publicado antes da inicialização.
O código corrigido passou, assim como a propagação de defeito e o cancelamento
cooperativo. Um cancelamento durante a aquisição protegida pode aguardar a carga
terminar; depois disso, impede a execução do consumidor. Não se declara
cancelamento imediato dessa aquisição ou de uma espera pelo lock do cache.

Na verificação final, passaram 90 testes com 459 assertivas em leitura, instruções,
recuperação e descoberta de agentes, mais três com 25 assertivas capturando as
requisições ao provedor. Permanecem três skips de symlink de arquivo no Windows
e um TODO de URL remota; uma criação independente de symlink retornou `EPERM`.
Junções de diretório foram verificadas. No Core, passaram 26 testes com 126
assertivas de inicialização, isolamento, configuração e provedores. O teste da
lista exata de ferramentas também passou a incluir o `mcp` canônico já integrado.

A interface passou em 22 testes com 54 assertivas; o Client em 16 com 75; o SDK
legado em um com uma; e a API de modelo padrão em quatro com 15. Os dois clientes
foram regenerados pelos scripts oficiais. Os tipos passaram em Core, Protocol,
Server, OpenCode, Client, SDK legado e App. O build de produção da interface
passou com os avisos existentes de chunks grandes, imports estáticos/dinâmicos e
mapa WASM duplicado. Os testes visuais usaram serviços próprios, depois encerrados.

Na mesma fixture de definições completas, o modo enxuto mede agora 24.642 bytes
com três ou 120 agentes. A descrição/schema do `read` acrescenta 1.055 bytes em
relação ao incremento anterior. Comparado ao catálogo padrão histórico sem as
ferramentas de descoberta/recuperação/paginação, são 2.271 bytes adicionais com
três agentes e 5.949 bytes a menos com 120. Não são contagens de tokens nem uma
garantia geral de economia.

As variantes Windows normal e baseline passaram, cada uma, nos três fluxos HTTP
compilados e em 76 assertivas. A primeira requisição de Location, após somente
o health global, é a consulta do modelo padrão: retornou `smoke/smoke` sem
aquecimento ou repetição. Os demais fluxos cobrem compactação, MCP por sessão e
OAuth sem replay. A assinatura foi conferida depois dos testes e o launcher
PowerShell 5 passou para ambas, a partir de outra pasta, sem Bun no PATH. A cópia
de teste não embute a interface web; seu bundle foi validado separadamente.

A revisão independente e a consulta sobre a disputa de inicialização usaram
`gpt-6-astra` com esforço `high`; as tarefas delimitadas usaram `gpt-6-luna` com
`high`. As falhas encontradas foram corrigidas e verificadas; não se declara
equivalência de inteligência com o Codex. O executável antigo de PID 9764 e seu
hash foram preservados, sem promoção ao diretório padrão. A meta geral continua
ativa com as pendências registradas acima.

## Incremento de projetos e seleção de pasta V2

`ProjectStore` no Core passou a compartilhar a leitura e a conversão dos registros
persistidos com o serviço legado. Os escritores e as identidades Git/global
continuam iguais. `GET /api/project` lista esses metadados sem inicializar uma
Location; `GET /api/location/paths` retorna a pasta pessoal do servidor e seu
diretório padrão. As duas rotas passam pela autenticação global. O diretório
selecionado e a raiz do projeto continuam sendo obtidos em `/api/location`.

A interface usa um cliente nativo delimitado para esses contratos e para
`/api/fs/list` e `/api/fs/find`, com o mesmo transporte e autenticação dos demais
clientes. O fluxo V1 permanece separado. Abrir uma pasta pelo fluxo V2 valida sua
existência antes de registrá-la, mantém o caminho escolhido e não inicializa Git.
Essas consultas são dados da interface, sem inclusão automática no contexto do modelo.

O teste visual encontrou uma segunda falha: o seletor web resolvia os caminhos,
mas o filtro fuzzy da lista descartava os resultados por diferenças entre barras
Windows, barras digitadas e `~`. Resultados de pastas já resolvidos agora passam
sem essa segunda filtragem; projetos recentes continuam pesquisáveis. Projetos
Git persistidos podem ser encontrados fora da pasta pessoal. A raiz global dos
projetos sem Git não é apresentada como se fosse a pasta originalmente escolhida.

Passaram 3 testes do novo armazenamento, 36 testes do projeto legado, 5 testes HTTP
com 23 assertivas, 17 testes do cliente com 83 assertivas e o teste do SDK legado.
Na interface passaram 40 testes focados, com 124 assertivas, e os 43 testes de
navegador do pacote, com 102 assertivas. Estes incluem o hook real de filtragem
para caminhos Windows e `~`. Os tipos passaram nos pacotes afetados. O bundle
final de produção passou com 2.568 módulos em 12,42 segundos, mantendo os avisos
existentes de chunks, importações e mapa WASM duplicado.

O navegador real, usando o bundle final sem diagnósticos temporários, confirmou
`~`, caminho absoluto, busca por nome de projeto, abertura de uma conversa Git
vazia, previamente criada pela API, por um link gerado pela interface e criação
de um rascunho na pasta comum, com indicação
“Sem Git”. Nenhum prompt foi enviado nesses passos. A árvore de seleção exclusiva
do desktop não teve validação visual. Um link de servidor montado manualmente com
base64 terminado em `==` ainda causa erro; essa variante e os consumidores legados
restantes continuam pendentes. A instrumentação temporária foi removida; não houve
alteração em sessão, timeline ou ciclo de vida dos comandos.

A tentativa de simular uma falha de rede no seletor mostrou somente o estado de
resultados vazios; não comprovou a visibilidade do aviso nem a recuperação pela
interface. A chamada do callback de erro e a invalidação do cache passaram em
teste do domínio, mas a validação visual desses dois passos continua pendente.
O registro HTTP final teve 1.659 respostas 200, uma 400 em consulta de mensagens e
50 respostas 404: 17 eram a sondagem esperada de `/global/health`, e 33 vieram de
consultas legadas de `/lsp`. Os dois últimos consumidores requerem investigação;
não foi verificada a renderização de uma conversa com mensagens existentes.

Os dois caminhos de saída Windows passaram novamente nos três fluxos HTTP
compilados, com 84 assertivas por caminho, e em 9 verificações externas adicionais
por caminho para autenticação e metadados a frio. Os arquivos normal e baseline
gerados neste host têm o mesmo hash; esses testes não comprovam compatibilidade
com uma CPU antiga. O launcher PowerShell 5 passou para ambos a partir de outra
pasta, sem Bun no PATH. A versão é `1.18.35+cudia.a1c9471a1874.8e8741ff0e13`, com
assinatura de fontes `8e8741ff0e13822b4a7a155944dd50a6dbe9b722`. A cópia de teste
não embute a interface web; seu bundle foi compilado e testado separadamente.

A revisão e o diagnóstico independente usaram `gpt-6-astra` com esforço `high`;
as subtarefas delimitadas usaram `gpt-6-luna` com esforço `high`. O processo antigo
de PID 9764 e seu hash foram preservados. A meta geral permanece ativa.

## Incremento de arquivos, disponibilidade LSP e paginação V2

A árvore, a busca e a leitura de arquivos da interface passaram a usar os
contratos nativos V2, com autenticação e transporte compartilhados. Caminhos são
codificados por segmento; nomes literais com Unicode, `%`, `#` e caracteres POSIX
não são tratados como parâmetros de URL. Texto preserva BOM, espaços e finais de
linha. Conteúdo com NUL ou UTF-8 inválido usa base64. Essa leitura da interface
ainda recebe o arquivo inteiro; não se declara um novo limite de memória para
downloads nem se envia o conteúdo automaticamente ao modelo.

Trocas de pasta e encerramento do provedor cancelam leituras pendentes. Respostas
e finalizadores antigos não podem sobrescrever a geração atual nem remover sua
requisição em andamento. A identidade do servidor e a pasta também participam da
remontagem dos provedores de sessão e rascunho. O tipo de apresentação conserva
`ignored` no V1 e deixa esse campo ausente no V2; a API nativa ainda não fornece
esse metadado. A interface deixa de consultar e apresentar LSP como disponível
no V2, cujo serviço nativo continua pendente.

A resposta 400 investigada no incremento anterior era uma requisição com
`limit=0`, originada pelo cache de uma conversa vazia. A paginação V2 agora
separa a janela lógica desejada do tamanho de cada página HTTP, entre 1 e 200.
Uma janela vazia usa o tamanho inicial de 20; janelas maiores atravessam cursores
sem descartar o histórico já solicitado. A recuperação de um turno incompleto
retoma o tamanho normal da página depois do último resto da janela, evitando
centenas de consultas de uma mensagem. O caminho V1 conserva limite zero quando
solicitado explicitamente.

Passaram 165 testes focados com 403 assertivas, os 46 testes de navegador do
pacote com 115 assertivas e a checagem de tipos da interface. A suíte de sessão
inclui 81 testes e verifica conversa vazia seguida de atualização forçada,
janela de 201, janela de 450, término do cursor e busca da raiz de um turno além
da janela. Os testes de arquivos usam HTTP real com autenticação, conteúdo
binário de 262.145 bytes e streams canceláveis. O construtor HTTP nativo é
preservado antes do HappyDOM no ambiente de testes, sem nova dependência.

O benchmark exigido foi registrado antes de alterar sessão e repetido depois,
em produção, com um worker e o mesmo Chromium 153.0.8010.12, revisão 1243. O caso
foi `streams assistant text in v2 with review pane closed`, com 320 turnos de
histórico, 160 eventos, lote 1, modo mínimo e fator de CPU 1. Ambos entregaram
160 eventos, sem pendências. O conteúdo inicial foi observado em 387,207 e
394,926 ms; a conclusão ocorreu em 40.398,7 e 40.390,2 ms. O p95 dos intervalos
RAF na janela de progresso foi 16,8 ms em ambos, sem long tasks. Uma execução de
cada lado indica resultado praticamente igual neste cenário; não demonstra
melhoria geral de desempenho nem mede o servidor nativo ou um provedor real.
Os logs, configurações temporárias e traces brutos foram preservados em
`%TEMP%/cudia-session-refresh-before-exact-20261015` e
`%TEMP%/cudia-session-refresh-after-exact-20261015`.

O bundle final `index-q6iGGNdw.js` foi validado no navegador contra Core e Server
nativos, com dados isolados e provedor local simulado. Uma conversa com mensagem
e resposta existentes foi renderizada pelo link gerado pela interface. Busca e
árvore abriram texto, o arquivo `ação #100%20.txt` e um binário com indicação
localizada. Uma leitura de AlphaGit foi retida até a troca para BetaPlain: o
sinal foi cancelado e a resposta tardia não apareceu no arquivo de mesmo caminho
do outro projeto, sem aviso de falha. Ao retornar a uma conversa vazia cujo cache
já estava antigo, a atualização real usou `limit=20` e respondeu 200. O registro
final teve 1.486 respostas 200 e quatro 404: duas sondagens de `/global/health` e
duas consultas de `/api/vcs/diff`. Não houve consultas `/lsp` nem resposta 400 em
mensagens. A árvore encontrou um arquivo criado depois da inicialização que a
busca indexada ainda omitia; a atualização desse índice permanece pendente.
Artefatos estão em
`%TEMP%/cudia-files-qa-20261015-8600fe043531438fa58fba4a3eac0c14`.

As duas saídas Windows foram compiladas na versão
`1.18.35+cudia.a1c9471a1874.3eb73264fa95`, com assinatura de fontes
`3eb73264fa95bc81d041fad716f7769e8d19a062`. Cada caminho passou nos três fluxos
HTTP compilados, com 84 assertivas, e no launcher PowerShell 5 a partir de outra
pasta, sem Bun no PATH. Os dois executáveis têm 144.902.144 bytes e SHA-256
`2590D367A57C7A733BB231EF0F76A8BD5E541BAE6FF8E234649A09B782B54566`;
a igualdade dos arquivos neste host não comprova execução em CPU antiga. A
assinatura do preview é UTF-8 sem BOM, com 41 bytes. O executável não embute a
interface web: o bundle foi compilado e validado separadamente.

Consultas de arquitetura e revisão independente usaram `gpt-6-astra` com esforço
`high`; subtarefas delimitadas usaram `gpt-6-luna` com `high`, pela skill
`codex-advisor`. A revisão identificou e confirmou a fronteira de caminhos e a
remontagem por servidor; nenhum bloqueio deste incremento ficou aberto. Os
serviços e navegadores próprios de validação foram encerrados. O processo antigo
de PID 9764 conserva o hash anterior, sem promoção ao diretório padrão; a meta
geral continua ativa com as pendências registradas.

## Incremento de busca atualizada e Git nativo V2

A busca de arquivos deixou de consultar uma lista parcial montada uma vez na
inicialização. Cada `find` aguarda sua própria varredura ripgrep; a interrupção de
uma consulta não cancela as demais. O próximo pedido reflete criação, exclusão,
renomeação e mudanças no `.gitignore`. Um código de saída 2 é erro quando a
completude foi solicitada. Fora de um projeto Git, o limite anterior de 100.000
arquivos passa a detectar excesso, em vez de apresentar a lista parcial como
completa. Não há observador obrigatório nem atualização periódica em segundo plano.

O mesmo caminho atende `find` mesmo quando FFF está disponível: sua API de scan
expõe um indicador de atividade, sem uma barreira de conclusão vinculada ao
pedido demonstrada nesta validação. A falha ao iniciar FFF usa ripgrep de verdade,
em vez de retornar listas vazias. Essa escolha favorece resultados atuais, sem
afirmar ganho de desempenho em repositórios grandes. Diretórios continuam
derivados dos arquivos; diretórios vazios e prontidão inicial/após alterações de
`glob`/`grep` FFF permanecem fora da garantia deste incremento.

`GET /api/vcs`, `/api/vcs/status` e `/api/vcs/diff` usam Schema, Core, Protocol e
Server nativos, sem importar o runtime OpenCode no Core. Os modos são `working`
e `branch`; o contexto opcional aceita inteiros de 0 a 2.147.483.647. A comparação
usa HEAD ou a base comum da branch padrão realmente existente. Uma comparação
indisponível é erro explícito; uma pasta sem Git é um estado vazio válido.
As respostas pertencem à pasta selecionada, incluindo subpastas e worktrees.

As leituras não atualizam o índice, não buscam remotos e desabilitam diff externo,
textconv, fsmonitor e filtros clean/process configurados nesses comandos. Os
processos têm cancelamento e prazo de 30 segundos. A saída de cada comando e o
conjunto de patches têm limite de 10.000.000 bytes; excesso retorna erro HTTP 413,
sem fabricar patch completo. O bootstrap da interface V2 carrega branch e branch
padrão pela nova API; os campos são adaptados para o armazenamento interno atual.
V1 conserva seu caminho. Ambos os clientes foram regenerados pelos scripts oficiais.
Nenhuma dessas consultas da interface amplia o prompt do modelo.

Validação deste incremento no Windows:

- Core Git: 15 testes, 55 assertivas, com um teste exclusivo de POSIX ignorado.
  Cobertura inclui alterações mistas, binários, repositório sem commit, worktree,
  subpasta, submódulo, nomes especiais, recriação após exclusão do índice, limites,
  cancelamento real, preservação dos bytes do índice e sentinelas de filtros externos.
- Busca/ripgrep: 10 testes, 36 assertivas. HTTP de workspace/Git: 10 testes,
  66 assertivas. Bootstrap/cliente nativo da interface: 14 testes, 47 assertivas.
  A verificação final ampliou a seleção App para 71 testes e 233 assertivas,
  incluindo caminhos literais, transporte de arquivos e descarte de caches;
  a bateria completa `test:browser` também passou.
- Checagens de tipos passaram em Core, Schema, Protocol, Server, cliente oficial,
  SDK legado, OpenCode e App. A variante normal e a baseline passaram, cada uma,
  nos três fluxos HTTP compilados, com 94 assertivas. Eles incluem compactação,
  descoberta de arquivo após a primeira busca, rotas VCS, MCP explícito e OAuth
  sem repetição de chamada com resultado incerto.

O bundle de produção `index-DhQOhSrF.js` foi validado contra Core/Server puros com
dados isolados e provedor local simulado. A revisão local mostrou dois arquivos;
a revisão da branch mostrou três, incluindo o arquivo exclusivo do commit. Seu
patch foi renderizado e voltar à revisão local restaurou o conjunto e o patch
esperados. Um arquivo criado após iniciar serviço e interface apareceu na paleta
e abriu com o conteúdo correto. Foram 274 requisições: 273 respostas 200 e uma
sondagem esperada `/global/health` com 404; as 17 consultas VCS responderam 200.
Não houve erros de página, notificações de falha ou consultas LSP. Registros,
resultados e capturas estão em
`%TEMP%/cudia-vcs-final-20261015-3774826303654a62b3836ddfbb4a0699`.

O benchmark de produção foi registrado antes e depois de alterar o bootstrap,
serialmente, no mesmo cenário de 320 turnos e 160 deltas. Conteúdo inicial:
376,689 → 371,989 ms; conclusão: 40.580,7 → 40.501,4 ms; p95 entre frames durante
progresso: 16,7 ms em ambos. Ambos entregaram 160 deltas, sem pendências, tarefas
longas ou intervalos de frame acima de 33 ms. O par não mostrou regressão nessa
fixture e não mede desempenho geral, de provedor real ou de VCS. Dados brutos,
configuração e traces estão em `%TEMP%/cudia-vcs-before-20261015` e
`%TEMP%/cudia-vcs-after-20261015`.

Preview daquele incremento: `1.18.35+cudia.a1c9471a1874.00edf601ea86`, assinatura
`00edf601ea860a4f085d8b45e21ad8882172dc8f`. As variantes Windows normal e baseline
têm 144.913.408 bytes e SHA-256
`6C1D1860A5E4EC1B094B77284EB6A74AF6523A47E65A9C944E97BA803E97D8BB`.
Ambas abriram pelo launcher PowerShell 5 a partir da pasta pai, com PATH sem Bun.
O stamp UTF-8 sem BOM tem 41 bytes. O bundle web foi validado separadamente e não
foi embutido no executável. A igualdade dos binários neste host não comprova
execução em CPU antiga; os testes POSIX não foram executados neste Windows.

A skill `codex-advisor` orientou a execução: Astra `high` fez consultas de
arquitetura e revisão independente; Sol `high` implementou o domínio Git; Luna
`high` fez testes de busca/HTTP e a adaptação do bootstrap. A revisão independente
encerrou os bloqueadores deste incremento após receber os artefatos e os resultados
da interface. Não foram medidos custos nem economia de tokens desses agentes.
Todos os serviços e navegadores próprios foram encerrados. O PID 9764 e o hash
do executável antigo foram preservados, sem promoção do preview. A meta geral
continua ativa.

A revisão automática de aprovação rejeitou a limpeza de
`%TEMP%/vcs-blob-probe-yIhwBb`, informando apenas “blocked by policy”. A fixture
temporária foi mantida, sem contornar a decisão; código e validações não dependem dela.

## Incremento de recursos MCP V2 sob demanda

O controle nativo `mcp` agora oferece `resources`, `templates` e `read`, seguindo
as operações de [recursos do protocolo MCP](https://modelcontextprotocol.io/specification/2025-11-25/server/resources).
Conectar continua separado de descobrir recursos; uma conexão não faz chamadas
de recursos ou templates nem lê documentos. A descoberta retorna metadados de
um servidor escolhido, e a leitura exige um URI exato. URIs são dados opacos:
não são resolvidos como arquivos locais, normalizados, decodificados ou alterados
em maiúsculas/minúsculas. Uma expansão de template pode ser lida sem constar na lista.

Os catálogos remotos são buscados somente por pedido explícito, com limites de
128 páginas, 1.000 itens recebidos e 1 MiB de JSON decodificado. Cursores opacos
vazios são preservados; repetições e excesso geram falha, sem catálogo parcial
apresentado como completo. Capacidade ausente é distinguida de catálogo vazio e
de erro em um método anunciado pelo servidor. Não há busca automática após uma
notificação de mudança.

A página apresentada tem até 16 itens e envelope JSON de 6.000 bytes. Busca usa
metadados completos, incluindo título e descrição, antes da seleção e paginação;
somente as prévias exibidas são abreviadas. Identidades não são abreviadas. Uma
identidade que não cabe é contada como omitida, avançando a página. `snapshot`
vincula a continuação à conexão, geração, tipo de catálogo, conteúdo e consulta.
Mudar a consulta ou invalidar o catálogo rejeita a continuação. Recursos e
templates compartilham a geração de invalidação, separada da geração das
ferramentas: mudanças em recursos não retiram ferramentas já expostas. O lock de
catálogo não retém o lock de desconexão.

As ações são `mcp.resources`, `mcp.resource.templates` e `mcp.resource.read`.
Passam pela admissão nativa antes do RPC, usando a identidade exata codificada
em bytes, sem aliases de case ou curingas nas permissões Windows. A sessão e a
Location são verificadas, assim como a identidade da conexão após preparação
OAuth e após o RPC. Respostas invalidadas por exclusão da sessão, desconexão ou
mudança da integração não são publicadas. A admissão é única: não se solicita
duas vezes uma autorização concedida apenas para aquela operação. Não se promete
revogação imediata de uma regra de permissão durante um RPC já admitido.

Cada leitura aceita até 8 MiB do resultado JSON já decodificado pelo SDK. É um
limite de aceitação, não de tráfego nem de memória máxima do transporte. Resultados
acima dele falham, sem conteúdo parcial bem-sucedido. Os aceitos preservam texto,
blobs e múltiplos conteúdos na estrutura canônica. A projeção de texto mantém as
linhas originais e os metadados do recurso; blobs ficam em JSON, sem afirmar que
o modelo percebeu uma imagem ou documento. Não há autenticação ou repetição
automática depois de um erro RPC.

O registro canônico continua sendo a única fronteira de prévia e retenção.
Uma leitura com mais de 50 KiB de texto multilinha produziu o artefato completo;
o `read` nativo, com as permissões apropriadas, recuperou o sufixo omitido por
offset de linha. Isso não prova recuperação exata de linhas arbitrariamente
longas ou blobs: o `read` limita cada linha. Um pager exato V2, pertencente à
sessão e com limites após serialização, permanece como próxima pendência do Goal.
Não foi criado um armazenamento paralelo de recursos.

Não houve alteração no prompt fixo. A skill MCP optativa documenta os novos
caminhos somente quando carregada. A definição JSON completa da ferramenta,
medida antes do adaptador, passou de 2.350 para 3.194 bytes UTF-8; a descrição
passou de 341 para 327 bytes. O acréscimo de 844 bytes não inclui um catálogo de
recursos e não é medição de tokens, tráfego final ou economia. A interface ainda
não tem um seletor nativo de recursos V2; a funcionalidade está no controle do agente.

Validação: uma execução conjunta do Core passou em 62 testes e 362 assertivas
de transporte, configuração, conteúdo, recursos, snapshots, permissões, gerenciador
existente e retenção. Depois, o caso adicional de cursor vazio passou separadamente
em um teste e quatro assertivas: 63 casos distintos verificados em execuções
separadas. As checagens `bun typecheck` de Core e OpenCode passaram. Também foi
corrigida a tipagem da expectativa de arquivo no teste compilado do incremento
anterior. O teste optativo com Playwright MCP real passou em um teste e duas
assertivas, preservando JavaScript e clique.

As variantes Windows normal e baseline passaram, cada uma, nos três fluxos
compilados com 113 assertivas. O fluxo MCP agora executa oito turnos: conexão,
recursos, templates, leitura, busca de ferramenta, exposição, chamada e conclusão.
As contagens comprovam zero RPC de recursos na inicialização, uma leitura do
URI exato e conteúdo somente após o pedido explícito, no papel de ferramenta,
fora das mensagens de sistema. Uma segunda sessão não recebeu conteúdo nem
ferramenta exposta da primeira. O provedor local simulado comprova posicionamento
e isolamento das mensagens, não resistência de um modelo real a prompt injection.
Não foram alterados App, sessão ou timeline; o bundle web e o benchmark anterior
continuam sendo os artefatos daquela validação, sem uma nova alegação de desempenho.

Preview daquele incremento: `1.18.35+cudia.a1c9471a1874.43a25c5bdce9`, assinatura
`43a25c5bdce95b8cb7359ce0af05eb694d8b6537`. As duas variantes têm 144.921.088
bytes e SHA-256 `8C17517427067D4C408317D110AE9C4F8DFBC96D143CE823A5C49590E904F843`.
Ambas passaram pelo launcher PowerShell 5 a partir da pasta pai, com PATH sem Bun;
o stamp UTF-8 sem BOM tem 41 bytes e a assinatura foi conferida após a compilação.
O executável não embute a interface web. A igualdade neste host não comprova
execução em CPU antiga nem substitui validação em outros sistemas operacionais.

Pela skill `codex-advisor`, Astra `medium` orientou a arquitetura, Astra `high`
fez revisão independente e Luna `high` executou subtarefas delimitadas de
transporte, testes e fluxo compilado. O executor integrou o gerenciador, catálogo
e controle nativo. Os bloqueadores do incremento foram encerrados após a execução
dos binários. Não foram medidos custos desses agentes. O PID 9764 manteve o
executável antigo e seu hash; não houve promoção ao diretório padrão. Não ficaram
processos próprios do preview em execução. A meta geral permanece ativa.

## Incremento de recuperação exata de resultados V2

O Core ganhou um `tool_result` canônico, registrado uma vez e incluído na
requisição do modelo somente quando a sessão tem resultados recuperáveis. A
seleção usa o histórico já carregado e uma consulta de existência por sessão
quando necessário, incluindo mensagens anteriores à compactação. Reiniciar não
depende de inscrições em eventos ou de um cache de exposição em memória.
Nenhuma orientação foi acrescentada ao prompt fixo.

A entrada usa `callID`, com `messageID` opcional; chamadas ambíguas exigem a
mensagem exata, inclusive quando uma duplicata está incompleta ou antes de uma
compactação. `text` recupera a projeção textual completa retida, ou o texto
persistido sem retenção. `structured` serializa o objeto estruturado gravado;
`content` serializa o array persistido e pode incluir mídia em linha. Esse último
array já pode conter texto abreviado, indicado por `contentTextBounded`.
Exatidão significa reconstruir a representação selecionada, não restaurar a
formatação JSON do serviço remoto nem conteúdo perdido na captura do produtor.
`captureTruncated` comunica o indicador de captura do Bash quando disponível.

Os offsets usam unidades UTF-16, sem dividir pares Unicode. Toda continuação
em offset diferente de zero exige o hash da mesma fonte. Cada envelope JSON
completo cabe em 6.000 bytes UTF-8 ou na configuração menor; se nem o envelope
couber, a operação falha explicitamente. O registro não volta a truncar páginas
bem-sucedidas. A definição completa mede 1.927 bytes de JSON antes do adaptador;
ela fica ausente na primeira requisição de uma sessão vazia. Essa medida não é
contagem de tokens nem prova de economia no tráfego final.

Artefatos novos vinculam sessão, mensagem e chamada por digest no nome. Somente
referências persistidas da chamada escolhida são aceitas, dentro do diretório
gerenciado, sem symlinks/junctions ou arquivos não regulares. Referências antigas
sem esse vínculo, arquivos ausentes e retenções com mais de sete dias falham
explicitamente. UTF-8 continua padrão; strings com surrogates isolados usam um
artefato marcado como UTF-16LE para preservar seus code units sem transformar uma
ação concluída em falha de codificação. O pager compartilhado mantém a API e os
defaults do V1.

A folha admite a permissão nativa uma vez e verifica sessão, Location,
propriedade e estado antes e depois da leitura. Exclusão, mudança de pasta e
poda durante a operação descartam a página. O armazenamento verifica identidade,
caminho e metadados do handle e do arquivo antes/depois, detectando alterações
comuns. Isso não garante uma leitura atômica contra escrita concorrente
adversarial. As regras dos candidatos da Arena permanecem inalteradas; seu deny
geral não concede automaticamente a ferramenta nova.

A leitura do artefato mantém apenas a janela solicitada e guardas de Unicode,
mas calcula o hash do conteúdo completo a cada pedido. A reconstrução integral
de 1 MiB ASCII em 256 páginas de 4.096 unidades levou 1.739,43 ms em uma execução
focada, com mediana de 5,05 ms e p95 de 13,21 ms por página; foram estimados 256 MiB
de conteúdo relido. Na execução conjunta, levou 2.029,31 ms. Não há limiar de
desempenho dependente da máquina. É um mecanismo de consulta seletiva com custo
`O(tamanho × páginas)`, não uma solução já otimizada para exportação integral.
Dados estruturados e mensagens já são carregados por inteiro pelo armazenamento;
não se afirma memória limitada para esses caminhos.

Validação final do Core: 159 testes, 1.026 assertivas em sete arquivos, cobrindo
registro, runner, histórico, armazenamento e folha nativa. Outros 42 testes de
MCP passaram com 302 assertivas. O pager V1 passou em dois testes e 67 assertivas;
as checagens `bun typecheck` de Core e OpenCode passaram. Cancelamento foi
verificado na API real e em um stream com leitura real já iniciada e próxima
leitura controlada, cujo handle fecha ao interromper. A fase privada exata da
API de armazenamento não foi instrumentada. Permissão negada, recusa de uma
aprovação e interrupção da folha mantêm seus comportamentos nativos.

As duas variantes Windows passaram, cada uma, nos quatro fluxos compilados com
370 assertivas. O fluxo novo executou 27 turnos de provedor simulado: reconstruiu
78.416 bytes de projeção em 17 páginas, recuperou um blob estruturado menor por
`callID` sem marcador, compactou e reabriu a sessão em outro processo próprio,
depois consultou o sufixo e EOF usando os IDs e hash anteriores. O contexto
compactado não continha mensagens de assistente; a exposição durável foi
reconstruída a partir do banco. Houve somente duas leituras MCP, uma por recurso,
sem repetir o produtor durante a recuperação. A primeira requisição e uma sessão
nova não receberam a definição. Conteúdo com marcador externo único apareceu
no papel de ferramenta e nunca no sistema. Isso prova posicionamento e
isolamento, sem demonstrar resistência de um modelo real a instruções externas.

O benchmark de produção da interface foi repetido antes/depois com 320 turnos de
histórico, 160 deltas, batch 1, CPU 1, modo mínimo e revisão fechada. Primeiro
conteúdo: 131,69 → 381,15 ms; conclusão: 40.588,7 → 40.442,2 ms; RAF p95 durante
progresso: 16,7 → 16,8 ms. Ambos entregaram 160 deltas, zero pendentes, zero
long tasks e zero gaps acima de 33 ms. A variação inicial é relatada sem conclusão
de desempenho. É um fixture da interface com transporte simulado, não medição
do backend nativo. Configurações, métricas e traces permanecem em
`%TEMP%/cudia-result-before-20261015` e `cudia-result-after-20261015`. O bundle web
continua `index-DhQOhSrF.js`, sem mudanças no App.

Preview deste incremento: `1.18.35+cudia.a1c9471a1874.2d70594956c6`, assinatura
`2d70594956c6f2089a62645c16a1ee64567cb224`. As duas variantes têm 144.934.400 bytes
e SHA-256 `57CC888EBE30DD6F5A43AA22248FE8EBD55FB65B40D23D2B309C527D93633537`.
O executável não embute a interface web. A igualdade de hash neste host não
substitui execução em CPU antiga ou outros sistemas.
O stamp UTF-8 sem BOM tem 41 bytes; a assinatura foi conferida após os testes.
Ambas as variantes passaram pelo launcher PowerShell 5 a partir da pasta pai,
com PATH sem Bun. O processo antigo, PID 9764, permaneceu em execução com
SHA-256 `B975A6B197A362D9BDF275542AB66827F011096317887729CE9C406A48837B1B`;
o diretório padrão continua sem stamp e não foi promovido. Os processos e
listeners próprios de validação foram encerrados.

Pela skill `codex-advisor`, `gpt-6-astra` em `high` orientou e revisou
independentemente o incremento; `gpt-6.1-sol` em `high` implementou armazenamento
e seus testes; `gpt-6-luna` em `high`
executou extração do pager e testes delimitados. O executor integrou a folha,
seleção durável, invalidação e fluxo compilado, corrigindo e verificando os
artefatos delegados. Não foram medidos custos dos agentes. A meta geral continua
ativa, com promoção ao diretório padrão e demais itens ainda pendentes.

## Incremento de leitura limitada nas ferramentas V1/V2

As respostas textuais de `read` agora contam a moldura inteira contra o teto
de 50 KiB/2.000 linhas ou a configuração menor. O V1 inclui caminhos, números
de linha e avisos; o V2 mede o JSON compacto completo, incluindo escapes.
Páginas não são devolvidas sem progresso: se a próxima linha ou entrada inteira
não couber, a ferramenta retorna erro explícito. O leitor de linhas usa chunks
e prefixo limitado; não percorre o restante de uma linha enorme para calcular
totais que não observou. Um trecho abreviado aponta para `textPage`.

O `textPage` nativo V2 recupera texto atual com BOM, CRLF, Unicode e hash do
conteúdo decodificado. Continuações usam UTF-16, sem dividir pares, e exigem
o hash. O envelope inteiro cabe em 6.000 bytes ou na configuração menor.
Arquivo alterado exige recomeçar; a operação não recupera bytes históricos
descartados de uma leitura anterior. Cada página relê o arquivo para calcular
o hash: o custo continua `O(tamanho × páginas)`, com apenas a janela solicitada
retida pelo pager. Não se afirma otimização para exportação integral.

As pastas são enumeradas com `opendir`, até 100.000 entradas ou 16 MiB de
metadados JSON codificados. Esse segundo teto não é uma medição de memória do
processo. O enriquecimento usa concorrência 16; a paginação preserva entradas
completas e exige `snapshot` após o primeiro offset. O identificador vincula
raiz canônica e lista ordenada observada; alteração exige recomeçar. O V2 mantém
a exclusão de links para fora da pasta; o V1 mantém sua listagem anterior de
links. Não se promete enumeração atômica contra alterações concorrentes.

No V1, instruções locais são entregues em lotes independentes antes do arquivo
ou anexo solicitado. O recibo cobre todo o lote e só vale se a versão completa
estiver no contexto selecionado. A entrada automática e a mídia usam leitura
real limitada, além do `stat`: crescimento acima do teto gera erro. O limite
de mídia é 20 MiB, separado do redimensionamento e da projeção posterior do
processador. O V2 mantém imagens como mídia nativa. As verificações de caminho,
identidade e metadados detectam alterações comuns, sem garantir atomicidade
contra escrita adversarial. Nenhum texto foi acrescentado ao prompt fixo.

O escopo deste incremento são as ferramentas: a API pública de arquivos e seus
consumidores da interface continuam separados. Carregadores de instruções
globais/remotas, proveniência completa do contexto e os demais itens da meta
geral permanecem pendentes. A poda adicional continua desabilitada.

Validação: Core com 102 testes/819 assertivas em sete arquivos; V1 com 103
testes/444 assertivas em três arquivos; cinco testes/61 assertivas adicionais
no caminho SessionPrompt → processador → provedor. Os três skips existentes de
symlink de arquivo no Windows e o TODO existente de URL remota continuam
registrados. As checagens `bun typecheck` dos dois pacotes passaram.
Os casos adicionais cobrem offset depois de uma linha de vários chunks, CRLF,
par Unicode na fronteira de abreviação, EOF sem continuação inventada, arquivos
que crescem ou mudam durante a leitura e liberação do handle ao interromper.
No caminho real do provedor simulado, recibo cortado provoca nova entrega, e
duas leituras no mesmo turno com uma instrução compartilhada retêm ambos os
alvos até selecionar os lotes completos.

Cada variante Windows passou nos cinco fluxos compilados, com 487 assertivas.
O novo fluxo fez 12 turnos de provedor, reconstruiu 8.446 bytes em duas páginas
exatas e sete entradas de pasta em quatro páginas. Verificou o JSON completo
na mensagem de ferramenta contra 6.000 bytes/oito linhas físicas, erros de hash
e snapshot e ausência do conteúdo de um arquivo cuja leitura foi negada.
Os outros fluxos cobrem compactação, MCP, OAuth e recuperação de resultados
através de compactação e reinício. São fixtures de protocolo com provedor local
simulado; não medem inteligência nem resistência de um modelo real a instruções.

O benchmark de produção antes/depois usou 320 turnos, 160 deltas, batch 1, CPU 1,
modo mínimo e revisão fechada: primeiro conteúdo 373,04 → 141,87 ms; conclusão
40.349,1 → 40.464,4 ms; RAF p95 de progresso 16,8 → 16,7 ms. Ambos entregaram
160 deltas, sem pendentes, long tasks ou gaps acima de 33 ms. O bundle principal
permanece `index-DhQOhSrF.js`. O fixture usa transporte simulado e não demonstra
ganho no backend nativo. Configuração, métricas observadas e traces estão em
`%TEMP%/cudia-read-before-20261015` e `cudia-read-after-20261015`.

Preview: `1.18.35+cudia.a1c9471a1874.386090d6c408`, assinatura de fontes
`386090d6c40824e4789732b7e03f3e17ff930aa5`, conferida após build e testes.
Normal e baseline têm 144.948.224 bytes e SHA-256
`5D6C79B8E69DFF6DD7757B7C05408171019AB67DB51D4BD5A14282FA0A1928F5`.
Ambos passaram no launcher PowerShell 5 a partir da pasta pai com PATH sem Bun;
o stamp UTF-8 sem BOM tem 41 bytes. A igualdade dos binários neste host não
substitui teste em CPU antiga. A interface web não está embutida no executável.
O processo antigo PID 9764 e seu hash permaneceram preservados; o diretório
padrão continua sem stamp e não foi promovido. Os processos próprios de teste
foram encerrados.

Pela skill `codex-advisor`, a revisão independente usou `gpt-6-astra` em `high`;
subtarefas delimitadas usaram `gpt-6.1-sol` e `gpt-6-luna`, ambos em `high`.
Os pedidos de checagem da revisão foram implementados e passaram. Custos dos
agentes não foram medidos. Este incremento de leitura foi concluído; a meta
geral permanece ativa.

## Incremento de aquisição limitada de instruções ambiente

O Core compartilha um carregador entre o V1 e o contexto nativo V2: 64 KiB por
fonte, 256 KiB por lote completo com cabeçalhos/separadores, 64 candidatos e
deadline remoto de 5 segundos. Os quatro valores aceitam somente reduções pelas
variáveis `CUDIA_INSTRUCTION_*` documentadas no README. A aquisição é sequencial;
o leitor de arquivos verifica bytes efetivamente lidos e identidade, e o leitor
remoto conta chunks entregues após descompressão, sem confiar em Content-Length.
O prazo inclui tentativas transitórias, headers e corpo. Cancelamento libera o
leitor e aborta a requisição. Não há repetição automática de falha no corpo.

A descoberta por glob coleta no máximo o teto mais um resultado para detectar
excesso, abortando o walker quando termina antes do EOF. A busca entre ancestrais
aplica o teto agregado. Isso não limita todos os metadados/caches internos do glob
nem constitui uma medição de memória do processo. No V1, expressões configuradas
e candidatos anteriores à deduplicação também consomem o orçamento de descoberta.

Não se admite um lote parcial. Ausência opcional é distinta de fonte descoberta
que desaparece; acesso negado, tipo incorreto, UTF-8 inválido, excesso, timeout e
falha HTTP geram diagnóstico. No V1, o erro completa e persiste a resposta do
assistente, publica o erro da sessão e encerra o turno antes do provedor. Corrigir
a fonte permite usar a mesma sessão novamente. O V2 bloqueia a inicialização ou
substituição incompleta e conserva integralmente o snapshot anteriormente
admitido durante uma observação indisponível; a correção posterior reconcilia o
conjunto completo. Uma fonte global ausente não ocupa uma vaga do teto reduzido.

As URLs configuradas continuam restritas ao carregador V1; o V2 conserva sua
descoberta existente de arquivos globais e `AGENTS.md` do projeto. Diagnósticos
removem credenciais, query e fragmento de URLs, enquanto a requisição e sua
atribuição preservam a URL configurada. Logs estruturados registram aquisição,
sem substituir um manifesto durável de origem de cada bloco do contexto. A
proveniência completa, inclusive plugins e retomadas, continua pendente.
Os tetos não limitam todo o histórico ou contexto já admitido. Não se promete
snapshot atômico contra escrita concorrente adversarial. Nenhum texto foi
acrescentado ao prompt fixo, e as permissões e a Arena permanecem preservadas.

Validação final: Core com 127 testes/365 assertivas em 12 arquivos, mais 99
testes/342 assertivas do runner nativo; V1 com 167 testes/670 assertivas em três
arquivos. Os 17 skips existentes de Windows e projeção V2 ficaram registrados,
sem falhas. O TODO anterior de instruções remotas foi substituído por testes
executáveis. As checagens `bun typecheck` dos dois pacotes passaram.
Uma fixture antiga de contexto usava o leitor anterior; foi substituída por
arquivo temporário real e a suíte completa afetada passou novamente.

Os testes cobrem fronteiras exatas de bytes com BOM/Unicode, moldura agregada,
crescimento durante leitura, fontes ausentes/inacessíveis, gzip e chunks,
timeout após headers, cancelamento, teto de descoberta e recuperação do snapshot.
O caminho SessionPrompt → processador → provedor confirma erro durável sem
chamada ao modelo e retomada após reparo. Cada variante Windows passou nos seis
fluxos compilados, com 550 assertivas. O novo fluxo faz quatro prompts V1:
rejeição local antes da rede/provedor, reparo, HTTP 404 com diagnóstico sem query
secreta e novo reparo; também confirma `AGENTS.md` na requisição nativa V2.
Os demais fluxos preservam compactação, MCP/OAuth e leitura/recuperação de
resultados através de compactação e reinício. São testes de protocolo com
provedor local simulado, sem medir inteligência ou resistência do modelo real.

O benchmark de produção antes/depois usou 320 turnos, 160 deltas, batch 1, CPU 1,
modo mínimo e revisão fechada: primeiro conteúdo 383,74 → 144,49 ms; conclusão
40.360,5 → 40.445,1 ms; RAF p95 de progresso 16,7 → 16,8 ms. Ambos entregaram
160 deltas, sem pendentes, long tasks ou gaps acima de 33 ms. O bundle continua
`index-DhQOhSrF.js`, sem alteração no App. O transporte desse fixture é simulado;
as medidas não demonstram ganho no backend nativo. Configuração, métricas e
traces estão em `%TEMP%/cudia-ambient-before-20261015` e
`cudia-ambient-after-20261015`.

Preview: `1.18.35+cudia.a1c9471a1874.79f0159d8d69`, assinatura de fontes
`79f0159d8d695f55b76bccd582e7ba56ad5c1239`, conferida após build e testes.
Normal e baseline têm 144.955.904 bytes e SHA-256
`8CA28385514F5A3B366EF64F00FC5CB6BF741E33497B211E428D9857E3AB0A25`.
Ambos passaram no launcher PowerShell 5 a partir da pasta pai com PATH sem Bun;
o stamp UTF-8 sem BOM tem 41 bytes. A igualdade dos binários neste host não
substitui execução em CPU antiga. A interface web não está embutida.
O processo antigo PID 9764 e SHA-256
`B975A6B197A362D9BDF275542AB66827F011096317887729CE9C406A48837B1B`
foram preservados. O diretório padrão segue sem stamp e não foi promovido;
processos e listeners próprios de validação foram encerrados.

Pela skill `codex-advisor`, arquitetura e revisão independente usaram
`gpt-6-astra` em `high`; subtarefas delimitadas usaram `gpt-6.1-sol` e
`gpt-6-luna`, ambos em `high`. O executor integrou o carregador compartilhado,
tratamento de erro, documentação e validação. Custos dos agentes não foram
medidos. Este incremento está concluído; a meta geral continua ativa, com
proveniência completa, demais ferramentas/interface e promoção ainda pendentes.

## Incremento de proveniência durável do contexto nativo V2

O texto-base e cada atualização cronológica agora recebem um manifest próprio,
com produtor, fase e origens observadas. Arquivos têm caminho canônico e posição
exata do corpo; skills e referências identificam os metadados realmente
incluídos, sem alegar leitura dos seus corpos ou diretórios. Cabeçalhos, avisos
de atualização e separadores permanecem atribuídos ao produtor. A remoção de
uma fonte gera uma parte de fase `removed`, sem readmitir seu conteúdo anterior.
O texto entregue ao modelo permanece igual ao dos renderizadores anteriores.
O catálogo sem solicitação de origem evita o custo de calcular esses hashes.

Os intervalos são UTF-16, com início inclusivo e fim exclusivo, e não cortam
pares Unicode. O manifest mede os bytes UTF-8 e calcula SHA-256 sobre
`JSON.stringify(text)` em UTF-8, distinguindo inclusive code units isolados.
Hashes de origens descrevem a entrada observada: metadados podem ter formatação
diferente do trecho renderizado. `valid` confirma vínculo e estrutura, sem
autenticar rótulos de origem ou seus hashes declarados.

O novo campo anulável `baseline_manifest` acompanha somente o texto-base da
geração. Atualizar o snapshot de comparação não altera esse manifest. Novas
gerações substituem texto-base, manifest e sequência juntos. Cada evento
`ContextUpdated` e sua mensagem projetada carregam o manifest da própria
atualização, preservado em replay e reinício. A migração adiciona o campo sem
reescrever texto, snapshot ou sequência antigos; ausência fica desconhecida.
Manifest inválido no texto-base é diagnosticado sem impedir o envio do texto
admitido. Mensagens duráveis continuam sujeitas ao seu schema.

A auditoria optativa versão 2 distingue base do agente, texto-base e atualizações
selecionadas do histórico, com sequência-base e IDs de mensagem. Seus estados de
origem são `valid`, `missing`, `invalid` e `omitted`. O orçamento agregado dos
manifests incluídos é 64 KiB; uma entrada que não cabe fica explicitamente
omitida, sem bloquear outra menor que ainda caiba. Conteúdo optativo continua
limitado a 64 KiB e o relatório inteiro a 512 KiB. Esses tetos não medem memória
do processo. Mesmo o modo `summary` pode guardar caminhos privados. `debug context`
também lê os relatórios anteriores da versão 1, identificando origem ausente.

Nenhum manifest entra nas requisições normais ou de compactação ao modelo. A
fronteira continua sendo a requisição preparada antes do adaptador. No OpenAI
Chat, o adaptador existente transforma atualizações cronológicas em mensagens
de usuário com `<system-update>` e escapes; o manifest continua vinculado ao
texto anterior à transformação. Identidade de hooks/plugins V1, transformações
posteriores de adaptadores, corpos carregados por ferramentas e linhagem
detalhada de resumos ainda estão pendentes. A meta de proveniência completa
permanece aberta, assim como os demais itens da tasklist.

Validação final: 224 testes Core/735 assertivas em 15 arquivos; 51 testes V1/171
assertivas em três arquivos e 49 testes de LLM AI SDK/nativo/159 assertivas em
dois arquivos. Total de 324 testes de código, sem falhas; três skips existentes
de symlink no Windows. Os casos incluem Unicode/BOM, bytes e hashes divergentes,
spans inválidos, wrappers, arquivos vazios, catálogos omitidos, snapshots
indisponíveis, registros antigos, replay, remoção e compactação. Um matcher
assimétrico do teste alterava o valor usado na asserção seguinte; substituí-lo
por verificações diretas resolveu a falha sem mudar a implementação.

`bun typecheck` passou em Core, OpenCode, Schema, Client, Protocol e Server.
O cliente público foi regenerado e a checagem de migrações passou. Cada variante
Windows passou nos sete fluxos compilados, com 669 assertivas. O fluxo novo
executou sete chamadas ao provedor local simulado, um reinício do próprio
processo de teste, duas gerações de texto-base, duas atualizações, remoção e
compactação. Conferiu SQLite, evento, mensagem projetada, relatório salvo,
payload do provedor e leitura de capturas v1/v2 pelo comando compilado. A primeira
expectativa procurava a atualização no papel `system`; foi corrigida para
verificar o wrapper de usuário que o adaptador efetivamente produz. As duas
variantes passaram depois da correção. Os testes não medem inteligência do
modelo nem autenticam a origem declarada por uma extensão.

O benchmark antes/depois usou 320 turnos, 160 deltas, batch 1, CPU 1, modo mínimo
e revisão fechada. Primeiro conteúdo: 513,97 → 405,93 ms; conclusão:
42.902,2 → 43.161,0 ms; RAF p95 de progresso: 50 → 50 ms. Long tasks:
22 → 29; gaps acima de 33 ms: 485 → 496. Ambos entregaram os 160 deltas,
sem pendentes. O bundle continua `index-DhQOhSrF.js`, sem edição do App.
O fixture usa transporte simulado: os resultados não estabelecem melhora,
ausência de regressão ou desempenho do backend nativo. A primeira tentativa
AFTER excedeu o prazo de inicialização do servidor de teste; confirmado seu
encerramento, apenas o timeout da configuração temporária foi ampliado de
120 para 300 segundos, e a repetição passou. Configurações, métricas observadas
e status estão em `%TEMP%/cudia-origins-before-20261015` e
`cudia-origins-after-20261015`. Não houve captura de Chrome trace neste incremento.

Preview aprovado: `1.18.35+cudia.a1c9471a1874.ab0e9aba9c7f`, assinatura
`ab0e9aba9c7f518c8089c6eeaf256f8a424806da`, conferida após build e testes.
Normal e baseline têm 144.963.584 bytes e SHA-256
`586B1803F4E2187F3488318F2A715A209DCEBB0D25EB8438F67389660D208097`.
Ambos passaram no launcher PowerShell 5 a partir da pasta pai com PATH sem Bun;
o stamp UTF-8 sem BOM tem 41 bytes. A igualdade de hashes não substitui teste
em CPU antiga. O executável não embute a interface web. O PID 9764 e SHA-256
`B975A6B197A362D9BDF275542AB66827F011096317887729CE9C406A48837B1B`
permanecem preservados; o diretório padrão segue sem stamp e não foi promovido.
Os processos e listeners próprios de validação foram encerrados.

A skill `codex-advisor` foi aplicada: `gpt-6-astra` em `high` orientou a
arquitetura e fez revisão independente; `gpt-6.1-sol` em `high` implementou os
manifests/renderizadores; `gpt-6-luna` em `high` executou auditoria e testes
delimitados. O executor integrou persistência, projeção, captura, CLI, geração
e fluxo compilado. A revisão foi encerrada sem bloqueador, baseada nos trechos
e resultados fornecidos, sem execução independente. Custos dos agentes não
foram medidos. Este incremento está concluído; a meta geral continua ativa.

## Incremento de distribuição e serviço de atualizações

O domínio informado pelo operador é `https://cyara.com.br`. A inspeção da aba
da Hostinger confirmou a falha da implantação `01a1414c-d550-7092-9a91-11dd97c00c27`:
o npm rejeitou `catalog:` ao tentar instalar a raiz do monorepositório Bun.
O serviço novo fica em `deploy/updates`, com `package.json` e lockfile próprios,
sem dependências externas. Essa será a raiz da aplicação na Hostinger, com
Node.js 22, npm, entrada `server.js` e nenhum comando de build. A configuração
do hPanel e a branch remota não foram alteradas neste incremento.

O serviço expõe manifests `stable` e `preview`, saúde e disponibilidade. Ele lê
no máximo 64 KiB mais um byte por arquivo, valida o envelope Ed25519 e seus
campos, e só então entrega exatamente os bytes publicados. A chave pública é
configurada no servidor; o futuro atualizador deverá ter sua própria chave
confiável fixada. O envelope assina os bytes do payload, sem canonicalização
JSON inventada. São recusados campos extras, chaves duplicadas, JSON excessivamente
aninhado, base64 não canônico, assinatura incorreta, canal divergente, datas
inválidas ou fora da validade e artefatos com metadados inválidos. O primeiro
contrato atende Windows x64, variantes normal/baseline, instalador/arquivo.

O publicador local lê uma chave privada fornecida externamente, assina, confere
o resultado e grava um arquivo temporário exclusivo antes da substituição por
rename. Ele rejeita a sobrescrita direta do payload ou da chave privada e mantém
a release anterior quando o novo payload é inválido. Não gera chaves nem faz
publicação remota. Chaves privadas não pertencem ao Git, à Hostinger ou às
variáveis do servidor. Nenhuma chave de produção foi criada neste incremento.

O estado inicial é deliberadamente sem release e com trust store vazio.
`/health` confirma que o processo responde; `/ready` confirma apenas um manifest
stable válido. Isso não comprova que seus downloads existem ou têm os hashes
declarados. O serviço não baixa nem aplica atualizações e não impõe monotonicidade
às releases: persistência de sequência, conferência do arquivo e proteção contra
rollback ainda pertencem à implementação futura do atualizador.

Validação: Node.js oficial `v22.23.3`, arquivo Windows conferido contra o SHA-256
publicado `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71`.
Em cópia limpa, `npm ci` normal passou sem dependências e `npm test` passou nos
11 testes, sem falhas ou skips. Os testes usam HTTP e Ed25519 reais locais,
incluindo assinatura adulterada, arquivos excessivos, limites do trust store,
chave do tipo errado, requisição malformada sem derrubar o servidor, publicador
executado pela CLI, import sem efeitos e preservação da chave/manifest anterior.
Uma tentativa inicial de teste do publicador falhou por usar a data fixa do
fixture com o relógio atual; a validade do payload foi corrigida no próprio teste.

O smoke independente iniciou `server.js` pela CLI em porta efêmera e conferiu
`/health` 200, `/ready` 503 e manifest 503 com erro público genérico. O próprio
processo filho foi encerrado. As evidências dessa validação ficam em
`%TEMP%/cudia-updates-clean-9192539d48a145e5b278dcef16de5959`.
Nenhuma fonte do motor, migração ou contrato HTTP do Core foi alterada: não houve
nova compilação, promoção do executável ou reinício da sessão antiga.

A skill `codex-advisor` foi aplicada: `gpt-6-astra` em `high` orientou a
arquitetura e outro advisor Astra em `high` encerrou a revisão independente sem
bloqueador; `gpt-6-luna` em `high` implementou o serviço e fez o inventário
delimitado do pacote Windows. O executor integrou documentação, revisão,
limite síncrono de leitura, teste adicional e validações finais. A revisão se
baseou nos trechos e resultados fornecidos. Não houve medição de custo dos agentes.
Instalador, launcher instalado, arquivo de conexão consumido pelo cliente,
atualizador, assinatura Authenticode e publicação HTTPS continuam pendentes.
Este incremento local está concluído; a meta geral continua ativa.

## Incremento do cliente Windows e defaults de distribuição

O cliente nativo em `installer/windows/launcher` implementa bootstrap fixo ABI 1,
launcher por versão, instalação de bundle assinado, atualização explícita e rollback.
Não exige Git, Bun, Node ou .NET para iniciar o harness empacotado. Preserva pasta
atual, argumentos, entrada/saída e código de saída do motor. Configuração, sessões e
credenciais do usuário não ficam nos diretórios de versão. O template de conexão
aponta para `https://cyara.com.br/updates/v1/stable.json` e não contém confiança
criptográfica. As chaves públicas pertencem ao executável compilado; o conjunto
de produção permanece vazio e impede consultas de atualização até ser provisionado.

O cliente verifica os bytes assinados Ed25519, canal, sequência, validade,
compatibilidade PE x64, tamanho, hash e inventário completo do ZIP. Rejeita nomes
inseguros, colisões, links, arquivos extras e limites excedidos. Downloads HTTPS
mantêm validação TLS, prazos, limite de redirecionamentos e conferência do tamanho
real. A instalação usa lock do Windows, staging exclusivo e uma única substituição
atômica do documento de ativação. Uma falha mantém a seleção anterior; rollback
local não reduz a maior sequência observada. Versões em uso não são sobrescritas.
O estado aceita até 128 registros e 8 MiB; coleta de versões ainda será implementada.

O motor agora carrega `CUDIA_DISTRIBUTION_DIR` como defaults de baixa precedência,
somente leitura. Configuração de usuário/projeto mantém sua precedência normal.
Agentes, comandos, skills e temas são carregados; plugins e políticas executáveis
do pacote são rejeitados. Aliases do diretório não permitem importá-lo como
plugins/ferramentas ou submetê-lo a migração, instalação npm e escrita de schema.
Configuração inválida de distribuição produz erro visível. O launcher não altera
os caminhos XDG nem define `OPENCODE_CONFIG_DIR`. Definir explicitamente um XDG
gravável dentro da instalação ainda aciona comportamento preexistente do Global;
esse uso não está coberto pela proteção dos defaults.

`build-client.ps1` compila uma cópia temporária do módulo Go com a chave pública
fornecida, sem alterar o checkout ou gerar chaves privadas. `package.ps1` cria um
ZIP novo e inventariado com motor, launcher e defaults selecionados. A cópia de
`tui.json` omite plugins de smoke. O bridge opcional leva fontes, mas ainda requer
provisionamento separado de dependências em diretório gravável. Seus MCPs permanecem
desabilitados por padrão. Comandos dependentes do checkout continuam em revisão.

Validação executada no Windows:

- Go oficial 1.27.2: `go test -count=1 -json ./...` e `go vet ./...` passaram.
  Foram 19 testes principais e 73 subcasos, 92 eventos de aprovação, sem skips.
  Incluem TLS real com CA de teste, interrupção/corrupção de download, locks e
  morte de processo, falha real de substituição de estado e retry, rollback e ZIPs
  inválidos. O helper de motor dos testes não é apresentado como motor de produção.
- Ctrl+C real em console Windows isolado: o driver conferiu que todos os processos
  anexados eram seus descendentes antes de emitir o evento. O helper recebeu o sinal,
  saiu com 23 e ambos os wrappers preservaram 23. A sessão do usuário não recebeu sinal.
- Configuração Core/OpenCode/TUI: 56/259/9 testes, 324 no total e 810 asserções,
  sem falhas. Typecheck Core, OpenCode, TUI e Server passou. Nenhum contrato público
  ou migração foi alterado neste incremento.
- Empacotador: dois testes passaram. Interoperabilidade Node 22 + PowerShell 5 +
  Go + motor compilado final: um teste composto passou, sem skip. Usou chaves
  temporárias, o publicador real e bootstrap de pasta externa com PATH sem Git/Bun/Node;
  conferiu preferências intactas e Arena com leitura permitida e edit/bash/task negados.
  Instalou uma segunda release enquanto o servidor real anterior estava aberto,
  preservou o ID e o acesso à sessão V2 e selecionou a nova versão na abertura seguinte.
  Não houve chamada a provedor nem validação de geração LLM durante a atualização.
- Oito fluxos compilados passaram em cada variante, 684 asserções por variante:
  defaults sem permissão de escrita via ACL Windows, V1, compactação, proveniência,
  exposição MCP, OAuth, leitura e recuperação de resultados após restart. A primeira
  execução esqueceu o prazo de integração e atingiu o timeout padrão de cinco segundos
  no teste de resultados; a execução com `--timeout 60000` passou sem alterar o motor.

Preview validado: `1.18.35+cudia.a1c9471a1874.b5c826d1a160`, fingerprint
`b5c826d1a160e022638e7551e98d0b92816839c8`. Normal e baseline têm 144.977.408 bytes
e SHA-256 `4191D6505E5AF3FA01EE53F55099D02EF7B1B30959826B9BD9DE52A87FC1F600`.
Ambos iniciaram pelo launcher PowerShell 5 da pasta pai, com PATH sem Bun.
O stamp sem BOM tem 41 bytes. O preview não embute a interface web; hashes iguais
não substituem teste em CPU antiga. O PID 9764 e o binário estável de SHA-256
`B975A6B197A362D9BDF275542AB66827F011096317887729CE9C406A48837B1B` foram preservados.
O diretório padrão continua sem stamp e sem promoção.

A skill `codex-advisor` foi aplicada: Astra `high` orientou a arquitetura e outro
Astra `high` encerrou a revisão independente sem bloqueador com base nos trechos
e resultados fornecidos; Sol `high` implementou o cliente Go e a integração dos
defaults, e Luna `high` fez inventário delimitado. O executor integrou empacotamento,
interoperabilidade, fixtures compilados, builds e documentação. Sem medição de custo
dos agentes ou alegação de ganho de desempenho. Um erro de tipo introduzido na
nova fronteira Effect foi corrigido no próprio incremento; o fixture ACL inicialmente
negava leitura por usar direitos excessivos e foi corrigido para negar apenas escrita.

Este incremento local está validado. Wizard, PATH, desinstalação, consultas automáticas,
manutenção do bootstrap, rotação de chaves, retenção, Authenticode, ambiente Windows
limpo e publicação HTTPS/Hostinger continuam pendentes. Não houve commit, push,
publicação ou alteração da implantação. A meta geral permanece ativa.

## Incremento de transações, PATH e remoção Windows

O turno anterior fez progresso verificável: entregou o cliente nativo e os defaults
somente leitura, com testes compilados e revisão. Neste incremento foram implementadas
as operações do helper que o wizard ainda deverá coordenar. O contrato está em
`installer/windows/INSTALLER-TRANSACTIONS.md`; não há wizard gráfico entregue.

A preparação verifica o bundle assinado e salva ticket, staging privado e journal,
sem trocar ativação, conexão ou bootstrap. Um bootstrap já existente deve coincidir
com o fornecido. O commit revalida assinatura/prazo, bytes, inventário e estado
anterior antes da ativação atômica final. Abort e repetição do commit reconhecem
interrupções inclusive depois da criação da conexão ou da ativação; limpeza não
desfaz uma ativação concluída nem elimina versões promovidas.

As APIs de PATH são fixas em HKCU e registram propriedade durável apenas de uma
entrada efetivamente acrescentada. Preservam tipo, tokens, entradas equivalentes
preexistentes e mudanças ambíguas. Uma interrupção entre Registro e journal deixa
estado explícito de revisão manual; o cliente não adota a entrada por suposição.
As operações compartilham lease de execução e lock de update. As releituras
reduzem disputas, sem alegar atomicidade com editores externos do PATH.

Bootstrap e launcher mantêm leases compartilhadas até o motor terminar. A remoção
exige lease exclusiva e também consulta processos antigos/diretos sob a instalação.
Não encerra processos. Valida o inventário inteiro antes de remover arquivos,
persiste um plano de retry e remove a ativação por último. Arquivos desconhecidos,
dados do usuário e diretórios não vazios são preservados. Links, aliases 8.3 e
reparse points não ampliam o inventário; remoção não usa exclusão recursiva.
Bootstrap, conexão, metadados do Inno e PATH ainda serão coordenados pelo wizard.

Validação final: `go test -count=1 -json ./...` e `go vet ./...` passaram no Windows:
55 testes principais e 124 subcasos, 179 eventos de aprovação, sem falhas ou skips.
Os testes de Registro usaram somente chaves HKCU exclusivas de teste; os testes
negativos das APIs públicas falharam nos locks antes de acessar o PATH real.
Incluem falhas de gravação, propriedade ambígua, tipo/valor vazio/ausente,
cancelamento e recuperação, leases e morte de processo, arquivos adulterados,
sharing violation real, retry sem ativação, junctions e hard links. Uma execução
intermediária encontrou fase inválida ao repetir remoção do PATH; o defeito novo
foi corrigido e a suíte final inteira passou.

O teste composto Node 22/PowerShell 5/Go com o motor real passou em 33,3 segundos,
sem skip. Exercitou o CLI de preparação/commit/abort, recusa de bootstrap ausente,
repetição idempotente, remoção preservando um arquivo desconhecido dentro dos
defaults e dados fora do inventário, e recusa de remoção com servidor real aberto.
A atualização assinada continuou preservando a sessão V2 anterior e suas preferências.
Não houve chamadas a provedores, alterações no PATH real ou remoção da sessão do usuário.
Fontes do motor não mudaram; o preview validado `b5c826d1a160` permanece aplicável.

Para obter o compilador oficial Inno Setup foi tentado um comando de download,
verificação e extração portátil. A revisão automática rejeitou a execução com a
razão genérica `blocked by policy`; o comando não executou e não foi repetido por
outra rota. Integração/compilação e testes do wizard permanecem pendentes. Essa
limitação não impediu os testes reais do backend nativo e do Registro isolado.

A implementação foi dividida entre três executores Sol `high` para transações,
leases/remoção e propriedade do PATH. Astra `high` orientou a arquitetura; a revisão
independente por outro Astra `high` aprovou o backend delimitado, sem bloqueador
remanescente identificado nos trechos e resultados fornecidos, sem inspeção autônoma
do repositório completo. Isso não aprova o wizard ou o instalador completo.
O executor integrou o CLI, bloqueios de manutenção, interoperabilidade e documentação.
Não há medição de custo dos agentes. A meta geral continua ativa, com os gates do
wizard, publicação, chaves, manutenção de bootstrap e demais itens da tasklist abertos.

## Incremento do wizard compilado e recuperação nativa

Com a autorização explícita do operador, o Inno Setup oficial 7.1.0 foi baixado,
conferido por SHA-256 e assinatura Authenticode válida de Pyrsys B.V. e extraído
em modo portátil por usuário. O bloqueio do compilador relatado no incremento
anterior foi resolvido; não houve instalação global nem alteração do PATH.

`build-installer.ps1` congela e valida bootstrap, helper, bundle e manifest assinada
antes de compilar `wizard.iss`. Exige confiança pública incorporada, confere o
helper contra o launcher assinado e testa a identidade do bootstrap. Não gera
chaves privadas. `-PrepareOnly` não declara compilação; todos os modos mantêm
`validatedForPublication: false`. As chaves de produção do checkout continuam vazias.

O wizard em português coordena arquivos, PATH e Aplicativos instalados pelo helper,
com ativação por último. A propriedade inclui identidade de arquivo persistida
antes da promoção. Uma intenção durável anterior à preparação interna permite
recuperar uma queda antes de existir o journal completo do wizard, sem assumir
transações manuais ou remover staging sem recibo. A revisão independente identificou
esse intervalo; o ajuste e a nova execução completa passaram antes de fechar a revisão.

A desinstalação persiste um plano completo e registra uma cópia durável de recuperação
fora da instalação antes de apagar arquivos. Ela pode ser repetida depois da remoção
do helper original e da ativação. Mantém lease exclusiva, recusa processos em uso e
preserva dados desconhecidos. Uma disputa real entre enumeração e saída de processo,
que causava erro 31, foi reproduzida e corrigida com confirmação de término pelo handle.
Não há encerramento de sessões do operador. A operação ainda deixa auxiliares próprios
e metadados, informando seus caminhos; a limpeza automática continua na tasklist.

Validação final após congelar o código:

- Go 1.27.2: 74 testes principais e 167 subcasos, 241 eventos de aprovação,
  sem falhas ou testes ignorados; os dois pacotes `cmd` não têm arquivos de teste.
  `go vet ./...` e formatação passaram.
- Node.js 22, PowerShell 5 e Inno 7.1.0: quatro testes passaram em 98,2 segundos,
  sem falhas ou skips, incluindo o instalador realmente compilado e o motor real.
- O wizard instalou em pasta Unicode, repetiu a instalação íntegra sem duplicar
  PATH e desinstalou. A falha de finalização retornou 73 e compensou suas mudanças;
  a manifest com assinatura inválida foi recusada. Os testes usaram uma cópia
  privada com destinos HKCU exclusivos; as chaves reais do usuário ficaram iguais.
- O bootstrap iniciou o motor real de outra pasta com PATH mínimo. A remoção foi
  recusada enquanto o servidor próprio do teste estava aberto. Uma sessão V2 real
  foi criada sem enviar prompt a provedor; SQLite e WAL/SHM presentes permaneceram
  byte a byte iguais após desinstalar. Isso não testa geração LLM durante a remoção.

Sol `high` implementou e validou o coordenador, pipeline e testes. Astra `high`
orientou a arquitetura e encerrou a revisão independente sem bloqueador demonstrado
nos trechos e resultados fornecidos; não inspecionou autonomamente o repositório
inteiro. Não há medição de custo dos agentes. Fontes do motor e preview `b5c826d1a160`
permanecem iguais; o executável estável e a sessão antiga não foram promovidos.

Uma tentativa de remover o auxiliar de teste antigo em
`%USERPROFILE%\AppData\Local\Temp\cudia-uninstall-4284086013` foi rejeitada pela
revisão automática com `blocked by policy`. Não houve repetição ou rota alternativa;
esse resíduo permanece. Os testes finais mantiveram seus auxiliares no fixture
temporário próprio e concluíram a limpeza desse fixture.

Ainda faltam QA visual e cancelamento, Windows limpo com os destinos reais,
limpeza dos resíduos próprios, confiança e assinatura de produção, publicação
HTTPS/Hostinger, consulta automática, retenção e manutenção do bootstrap, além
dos demais itens da meta geral. Não houve commit, push ou implantação. Este
incremento está validado localmente; a meta permanece ativa.

## Promoção do motor validado e comandos portáveis do pacote

Uma nova consulta ao inventário de processos confirmou que a sessão antiga do
PID 9764 já havia terminado. Nenhum sinal ou comando de encerramento foi enviado.
Após conferir o fingerprint atual e os hashes de ambas as variantes do preview,
o executável padrão foi aberto exclusivamente e substituído pela cópia validada.
O binário anterior permanece em
`packages/opencode/dist-cudia-before-promotion-20261015231853-25cc27c1/opencode-windows-x64.exe`,
com SHA-256 `B975A6B197A362D9BDF275542AB66827F011096317887729CE9C406A48837B1B`.

O diretório padrão `packages/opencode/dist` agora contém normal e baseline de
`1.18.35+cudia.a1c9471a1874.b5c826d1a160`, com o mesmo SHA-256
`4191D6505E5AF3FA01EE53F55099D02EF7B1B30959826B9BD9DE52A87FC1F600` e stamp sem BOM
de 41 bytes. Ambos passaram por `run.ps1 --version` a partir de uma pasta temporária
externa com PATH limitado a System32. Os testes funcionais compilados do preview
continuam sendo a evidência desse motor; esta promoção não declara teste em CPU antiga.

O pacote passou a substituir seis comandos por variantes portáveis: `ai-deps`,
`changelog`, `commit`, `issues`, `rmslop` e `translate`. Descobrem manifests, repositório,
refs e idiomas no projeto do usuário, preservam o modelo selecionado e dispensam
scripts específicos do checkout CUDIA. As fontes originais em `.opencode/command`
ficam intactas. O teste real do empacotador passou: dois testes, sem falhas ou skips,
conferindo os seis textos no ZIP, ausência dos modelos fixos, hashes dos arquivos
originais antes/depois, inventário completo e preservação de um comando não substituído.
Isso valida o empacotamento dos prompts, sem alegar geração LLM ou execução dos
comandos em projetos externos. A skill Effect permanece específica de projetos
com Effect v4; dependências opcionais e demais gates de distribuição continuam abertos.

Consulta HTTPS direta nesta continuação: `https://cyara.com.br/health` e
`https://cyara.com.br/ready` responderam 404. O serviço local validado ainda não
está demonstrado nesses endpoints públicos. A implantação e a confiança de
produção continuam pendentes; essa consulta não alterou a Hostinger.

## Limpeza própria do desinstalador — incremento validado localmente

A limpeza própria passou pelos gates locais e pela revisão independente. A
revisão Astra `high` havia confirmado uma lacuna na exclusão final de dois arquivos:
apagar o helper antes de seu recibo poderia deixar o recibo sem comando de
recuperação. A direção aprovada mantém a chave de Aplicativos instalados e
transfere a última limpeza para o PowerShell do Windows, com recibo tipado no
Registro. A chave só pode desaparecer depois dos arquivos próprios, removendo
recibo e comandos de recuperação juntos. O programa final não recebe permissão
para apagar arquivos da raiz do aplicativo.

Um mutex Global por SID real do usuário e chave de aplicativo serializa as
operações mesmo entre raízes diferentes. Seus testes passaram entre processos,
incluindo abandono, retomada com revalidação, exceção, recursão e conferência
real do proprietário/DACL. O executor acrescentou a recusa de objetos preexistentes
permissivos ou sem DACL protegida; a suíte focada passou após esse ajuste.

O Restart Manager identificou o McAfee Framework Host segurando uma cópia de
teste, impedindo sua abertura exclusiva por mais de 45 segundos. Não houve
alteração do antivírus ou sinal a esse processo. Um novo teste isolado validou
abertura que admite somente leitores e bloqueia escritores/exclusões concorrentes,
conferência no mesmo handle e remoção do nome com `FileDispositionInfoEx`.
O leitor previamente aberto continuou lendo os bytes originais; o arquivo e a
pasta vazia desapareceram. Essa é a semântica documentada pela
[Microsoft para disposição POSIX de arquivos](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information_ex).
Os locks da instalação continuam exigindo exclusividade.

O programa de recuperação passou em testes reais de PowerShell com leitor aberto,
contenção por um escritor seguida de retry pelo mesmo comando registrado, e
recusa de recibos malformados ou adulterados. A suíte Go completa, o wizard
compilado, os cenários de queda e a revisão final foram concluídos depois desses
testes focados e estão registrados abaixo. Persistência crítica do Registro usa flush explícito,
observando os direitos de consulta exigidos por
[RegFlushKey](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regflushkey).

O novo protótipo de disposição clássica deixou inicialmente um arquivo em
delete-pending sob o leitor externo. O Windows depois concluiu essa exclusão;
o executor conferiu e removeu somente a pasta de teste já vazia, sem recursão.
Isso é separado do resíduo antigo cuja exclusão foi bloqueada pela revisão
automática: aquele caminho não foi acessado nem retomado.

A revisão final encontrou uma janela adicional: uma queda depois de gravar os dois
comandos PowerShell e antes de confirmar o handoff deixava ambos sem retomada.
O retry registrado agora reconhece esse estado e recupera somente os comandos
nativos, conferindo todo o inventário presente e o helper/recibo atual. Não exclui
arquivos; pede para repetir a remoção. Cada comando é descarregado e conferido
antes do checkpoint nativo final. A restauração nativa segue o mesmo contrato.
Histórico confirmado e ausente não é recriado nem adotado.

A suíte Go completa, executada em sequência antes dos testes Node, passou com
112 testes principais e 265 subtestes: 377 eventos de aprovação, zero falhas ou
skips de teste, mais dois pacotes de comandos sem testes. `go vet ./...` passou.
Os testes incluem saídas reais sem defers e abandono do mutex durante as escritas.
Uma execução anterior simultânea ao wizard recusou consultar um `launcher.exe`;
o caso isolado e a execução serial completa passaram sem relaxar essa proteção.
O gate compilado também passou: seis testes Node.js 22 em sequência, zero falhas
ou skips, em 441,391 segundos; o wizard consumiu 368,589 segundos. Cada uma das
16 combinações normal/silenciosa usou uma instalação independente, término real
sem defers e o comando literalmente registrado. A recuperação PowerShell não
alterou arquivos e pediu uma segunda invocação; o comando nativo restaurado e
os comandos nativos em estados mistos concluíram a limpeza. O teste também
conferiu que a raiz vazia desaparece e arquivos desconhecidos em `state` permanecem.

Os diálogos foram substituídos somente na cópia privada de teste para permitir
executar os comandos normais sem interação. Os hashes dessas alterações de
apresentação constam no perfil de teste; isso não comprova a GUI de produção.
O instalador CUDIA TEST teve SHA-256
`d6df9a9dc467979e3eaf0f5b1c96c132f6b8bb27801e859ca3dedda24e7626b9`, e o perfil privado
`9998b011295da0fac228c3b2fc351cde7354221662a3652b8f6730e28962679f`.
Os fixtures e suas chaves privadas temporárias foram removidos pelo teste.
Sessão V2 ociosa real, SQLite/WAL/SHM e chaves reais protegidas do Registro
permaneceram íntegros; nenhum prompt foi enviado a provedor.

Astra `high` encerrou a ressalva sem bloqueador demonstrado no pacote selecionado.
`gpt-6.1-sol/high` implementou o programa final de recuperação e o mutex;
`gpt-6-luna/high` preparou os seis comandos portáveis, e `gpt-6-astra/high` revisou
as decisões e a conclusão. O executor manteve a integração e as verificações finais.
Não há medição de custo que permita alegar economia dos agentes.

Este incremento está validado localmente. QA visual/cancelamento, Windows limpo,
PATH padrão em terminal novo, chaves e assinatura de produção, publicação HTTPS,
Hostinger, consulta automática, retenção e manutenção do bootstrap continuam
pendentes. Não houve commit, push ou implantação; a meta geral permanece ativa.

## Consulta automática de atualizações — incremento de 15/10/2026

A consulta agora começa em segundo plano na abertura interativa quando o prazo
vence. Novas conexões do wizard habilitam a opção; conexões existentes e tickets
antigos mantêm sua política. Sem chaves públicas compiladas não há consulta
automática. O intervalo padrão é 24 horas, avaliado ao abrir uma sessão; uma sessão
continuamente aberta não agenda um timer. Falhas aguardam 24 horas e cancelamento
pelo encerramento do motor não grava falha. Não há download de arquivo nem ativação
automática: um aviso verificado na abertura seguinte orienta `cudia update`.

O cache estrito e limitado vincula o resultado à raiz, conexão, chaves compiladas,
variante, release selecionada e maior sequência conhecida. Cada aviso revalida a
assinatura e a validade atuais. Arquivos desconhecidos, aliases ou conteúdo inválido
são preservados e suspendem a consulta. A escrita confere identidade e conteúdo
antes da substituição atômica, sob mutex efêmero por instalação. Não há CAS universal
contra edições externas do mesmo usuário; temporários incertos após queda são
preservados. A desinstalação inclui somente um cache estruturalmente reconhecido e
vinculado à raiz, usando o inventário e os três locks originais.

Uma prova compilada iniciou o bootstrap instalado em console privado enquanto o
servidor HTTPS retinha a resposta. O motor de teste iniciou antes da resposta; sua
saída cancelou a consulta, não gravou cache de falha, preservou a ativação e liberou
a lease. Somente a cópia privada desse teste confia na CA e chave temporárias.
O TLS de produção continua verificando certificados normalmente.

A suíte Go completa passou com 130 testes principais e 295 subtestes, 425 eventos
de aprovação, zero falhas ou skips de teste, em 234,854 segundos. Os dois pacotes
de comandos não têm testes; `go vet ./...` passou. Os 43 arquivos Go mantiveram
seus hashes durante a validação. O motor padrão e baseline mantêm o fingerprint
`b5c826d1a160e022638e7551e98d0b92816839c8` e os executáveis anteriormente validados.

O primeiro gate Node encontrou uma corrida no leitor do teste: `RegQueryValueEx`
retornou 1018 depois que a limpeza excluiu a chave já aberta. O leitor agora refaz
o snapshot completo somente para os códigos nativos 2/1018, com tentativas limitadas,
descartando o handle anterior. Só retorna ausência depois de reabrir a chave;
outros erros e esgotamento continuam falhando. Uma prova real confirmou o 1018 no
handle antigo, ausência na reabertura e o valor novo quando a chave é recriada.

A execução serial final passou nos seis testes Node.js 22, sem falhas ou skips,
em 424,804 segundos; o wizard consumiu 350,685 segundos. Conferiu remoção do cache
reconhecido, preservação de conteúdo desconhecido e dos bytes SQLite/WAL/SHM de
sessão V2 real ociosa, além das 16 retomadas literais normal/silenciosa após quedas
sem defers. O cache de falha desse cenário é um fixture sintético de propriedade;
falhas HTTPS reais são verificadas pela suíte Go. Nenhum prompt foi enviado a provedor.

O instalador CUDIA TEST teve SHA-256
`d8fcb61e72b91eff49df79b7ba7d45e5aa39e432c037f00e37a688ea9593e6ba`, com perfil privado
`e89dc78bf59207a8aa6bfb1bc2b5816745c5cb5f3bf7959e125d394785515b72`.
Os diálogos foram substituídos somente na cópia privada de teste; isso não comprova
QA visual ou cancelamento da GUI de produção.

`gpt-6.1-sol/high` implementou o núcleo da consulta; o executor integrou instalação,
limpeza e a prova compilada. `gpt-6-astra/high` revisou as decisões e os resultados.
Não há medição de custo que permita alegar economia dos agentes.

QA visual/cancelamento, Windows limpo, PATH padrão em terminal novo, chaves e
assinatura de produção, publicação HTTPS/Hostinger, retenção e manutenção do
bootstrap continuam pendentes. A consulta automática encerra seu gate local;
a entrega pública e a meta geral permanecem abertas. Não houve commit, push
ou implantação neste incremento.

## Busca com escopo explícito e SDK embutido — incremento de 15/10/2026

O `grep` nativo V2 não transforma mais um caminho inexistente em busca no
diretório pai. Glob e grep resolvem caminhos canônicos, reutilizam a permissão
`external_directory` para alvos absolutos externos e aplicam depois a permissão
da operação. Negação impede a busca. Após a aprovação, conferem novamente o
caminho; grep também confere o tipo para impedir que um arquivo substituído por
um diretório amplie o escopo. Aliases internos que escapam da localização são
recusados; aliases externos explícitos pedem autorização para o destino real.
Essas verificações não fornecem imunidade a toda troca concorrente posterior.

O serviço de busca V2 agora usa Ripgrep por requisição para `find`, `glob` e
`grep`, com argumentos separados para caminho, regex e filtro. O picker FFF e
seu watcher deixaram de ser inicializados por esse serviço; o seletor
`OPENCODE_DISABLE_FFF` foi removido. O adaptador FFF continua disponível para
benchmarks de desenvolvimento. A aceleração FFF não está aprovada para uso no
serviço: uma investigação real do SDK 0.9.4 encontrou resultado vazio durante
a varredura inicial, glob limitado a 100 itens, falhas de escopo em caminhos com
espaços, fallback de regex inválida para texto literal e páginas de grep acima
do limite pedido. Todos os finders da investigação foram encerrados.

Os testes do backend escolhido conferem 174 arquivos e 403 ocorrências sem teto
de página implícito, limites explícitos de 7/13, criação, edição, renomeação e
remoção na mesma localização. Também verificam Unicode, espaços, colchetes,
offsets UTF-8, regex inválida, filtros e escapes por junction. A regra nativa do
Ripgrep foi preservada e está nas descrições: `include` filtra buscas em
diretórios; um arquivo indicado diretamente é pesquisado independentemente do
filtro e não inclui seus vizinhos. O modelo recebe aviso quando o limite
solicitado é atingido, sem afirmação de que existem resultados adicionais.

A validação encontrou separadamente um erro preexistente do SDK embutido:
os handlers globais de caminhos e projetos exigiam serviços no contexto de cada
requisição, causando falha de tipos no host. Agora capturam os serviços na
construção dos grupos, como os demais handlers globais; os valores dinâmicos e
a consulta de projetos continuam sendo avaliados por requisição. O router real
foi testado antes de criar qualquer sessão. O chamador do SDK continua usando
`web.handler(request)`, sem casts ou contexto artificial. As formas de dados do
protocolo HTTP não mudaram.

A suíte integrada do Core passou com 255 testes, 1.271 assertivas e zero falhas
em 27 arquivos (19,50 segundos). Houve um skip preexistente do watcher de `.git`
por symlink no Windows; as novas provas de junction deste incremento rodaram.
Os sete testes do SDK passaram, com 50 assertivas e zero falhas. As checagens de
tipos de Core, OpenCode, Server e SDK Next passaram.

As duas variantes Windows passaram nos oito fluxos compilados, com 735
assertivas por variante e zero falhas/skips, em 43,58 e 41,58 segundos. A cobertura
de leitura/busca observa as mensagens reais do adaptador enviadas ao provedor
local de teste: caminho inexistente falha sem expor vizinhos; arquivo explícito
mantém escopo; glob encontra um arquivo criado depois; limite gera aviso;
regex inválida falha; conteúdo externo negado não aparece nas requisições.
Os fluxos anteriores de compactação, origens, MCP, OAuth, instruções V1,
recuperação de resultados e defaults distribuídos também passaram. Isso não
avalia inteligência de um modelo nem resistência geral a prompt injection.
Nenhum provedor pago foi usado.

O build `1.18.35+cudia.a1c9471a1874.29be8f8233dd` usa o fingerprint
`29be8f8233dd6719e0160bde3aa28596978da06c`. Ambos os executáveis têm
138.476.032 bytes e SHA-256
`B3EDDF1F37BFB76D0B1DEC84BD831AE4FA00922A24B5205591F7D44B5149E48D`.
O catálogo público de models.dev foi fixado uma vez para os dois builds:
5.671.652 bytes e SHA-256
`CD3759D47942B31A231E3C14869A70E30457EAB91267AE669A3AD556BE122466`.
A igualdade dos executáveis neste host não prova compatibilidade com CPU antiga.

O build validado foi promovido ao diretório padrão após conferir ausência de
processos em uso, hashes e abertura exclusiva dos arquivos anteriores. Cada
substituição usou `MoveFileExW`; o stamp de 41 bytes UTF-8 sem BOM foi gravado por
último. O executável b5 anterior, idêntico nas duas variantes, e seu stamp estão
em `packages/opencode/dist-before-search-4e1f3f24a6aa4574b6aadf24e339a167`.
Os dois launchers PowerShell 5 retornaram a versão nova de uma pasta externa,
com PATH contendo apenas System32. Nenhum processo do usuário foi encerrado.

O executor principal integrou as mudanças. `gpt-6-luna/high` investigou o SDK FFF
sem editar o repositório; `gpt-6-astra/high` revisou as decisões, resultados e
critérios de promoção pela skill `codex-advisor`. Não há medição de custo dos
agentes. Foram preservados 6.855 registros não relacionados do índice Git;
somente os 12 caminhos deste incremento foram preparados. Não houve commit,
push ou publicação. LSP nativo, demais itens da tasklist e os gates de produção
do instalador continuam abertos; a meta permanece ativa.

## Consultas LSP nativas V2 — validado

O novo runtime pertence ao Core e usa processos da Location, sem importar o
runtime V1. A ferramenta oferece definição, referências, hover, símbolos do
documento e da workspace, implementação e preparação/entrada/saída da hierarquia
de chamadas. Descrições e schemas entram no catálogo somente quando LSP está
habilitado; nenhuma orientação fixa foi acrescentada ao system prompt.

Configuração ausente ou `false` mantém LSP desativado. `true` descobre, na primeira
consulta autorizada, comandos já instalados de TypeScript, Go, Python, Rust e
C/C++. Um objeto seleciona somente os servidores listados, com comando e
extensões explícitos; os cinco IDs conhecidos podem aproveitar suas extensões
padrão. Não há instalação automática. A configuração é o snapshot da Location:
alterações exigem reabri-la. Falhas de inicialização ficam retidas até essa
reabertura, sem repetir automaticamente a operação.

A permissão `lsp` autoriza a consulta e a admissão do documento. `workspaceSymbol`
exige também autorização de `"."`, pois seus resultados podem vir de outros
arquivos internos. Arquivos externos são recusados antes de solicitar uma
permissão que não permitiria executar essa operação. Entradas de localização
externas nos resultados são removidas inteiras, com contagem de omissões. O servidor
configurado continua sendo um processo confiado pelo operador: regras sobre o
arquivo de entrada não isolam sua leitura ou indexação. Pedidos do protocolo para
aplicar edições ou executar comandos são recusados. A Arena continua negando LSP
pelas permissões existentes.

O transporte usa `vscode-jsonrpc@8.2.1`, com framing limitado sobre `AppProcess`.
Os limites incluem 16 consultas ativas, oito conexões, 32 requisições pendentes,
fila de escrita de 8 MiB, documentos de 2 MiB, mensagens de 4 MiB e resultados de
1 MiB/256 entradas. O cache retém hashes, versões e posições finais, sem guardar
cópias dos documentos. As posições são UTF-16; alterações usam sincronização
completa ou incremental conforme a capacidade negociada. Cancelamento local
libera a requisição e solicita cancelamento ao servidor, sem afirmar que o
servidor interrompeu o trabalho.

A validação encontrou e corrigiu duas falhas de encerramento. Uma escrita
bloqueada podia perder seu listener de erro antes do fechamento do pipe e gerar
`EPIPE` sem tratamento. A ordem agora encerra a conexão e o processo próprio antes
de abortar o escritor. Vários chamadores aguardando a mesma inicialização também
podiam deixar uma espera interna presa. A prontidão compartilhada usa uma Promise
com o resultado completo, inclusive falha/interrupção, espera fora do lock e no
máximo 32 registros acumulados até a conclusão. A reprodução com três chamadores
passou com o mesmo limite original de cinco segundos. Não houve alteração global
no Effect nem no spawner de processos.

Verificação final deste incremento:

- Core: 331 testes passaram, sem falhas, com 1.606 verificações em 30 arquivos.
  Incluem os 40 testes focados de runtime/ferramenta LSP, com 205 verificações.
- SDK Next: sete testes passaram, com 50 verificações em três arquivos.
- Core, Opencode, Server e SDK Next: quatro checagens de tipos sem erros.
- Normal e baseline: nove fluxos compilados passaram em cada variante, com
  770 verificações por variante, em 47,53 e 49,85 segundos respectivamente.
- O fluxo LSP usa `typescript-language-server@5.0.1` e TypeScript `5.8.2`, com
  versões verificadas, instalados somente numa pasta temporária de validação.
  Confere ausência de processo antes de negação/autorização e consultas reais de
  hover, definição, referências e símbolos do documento/workspace.
- Os testes controlados cobrem framing fragmentado/inválido, Unicode/CRLF,
  sincronização completa/incremental, stderr e rajadas de mensagens, backpressure,
  cancelamentos e respostas tardias, fechamento antes/durante a inicialização,
  escrita bloqueada, isolamento dos chamadores e recusa de edições pelo protocolo.

A primeira chamada direta ao Bun usou por engano seu timeout padrão de cinco
segundos e interrompeu o teste antigo de compactação/reinício. A chamada foi
corrigida para `bun run test`, usando os 30 segundos já definidos pelo pacote.
As duas rodadas completas passaram sem alterar código ou limites de teste para
contornar essa falha de invocação.

O motor padrão agora é `1.18.35+cudia.a1c9471a1874.7b1cb2b7c080`, fingerprint
`7b1cb2b7c080be946800b9bdca723d8213659342`. Os dois executáveis têm 138.500.608
bytes e SHA-256 `5905373E65DB1352FF8B80006EC1DDD1F87E10C86FFC784AB3D0650B3263A5BE`.
O build reutilizou o catálogo models.dev fixado no incremento anterior; as fontes
foram conferidas novamente após a compilação. A igualdade dos executáveis neste
host não constitui teste em CPU antiga.

A promoção conferiu ausência de processos usando os caminhos padrão, hashes,
stamp anterior e abertura exclusiva dos arquivos. Preservou o executável anterior
`29be8f8233dd`, idêntico nas duas variantes, e seu stamp em
`packages/opencode/dist-before-lsp-d2e5f1972c6f46ee881778e7a9af281a`.
Cada substituição usou `MoveFileExW`; o stamp de 41 bytes UTF-8 sem BOM foi gravado
por último. As duas variantes retornaram a versão nova pelo `run.ps1` no
PowerShell 5, numa pasta externa, com PATH contendo somente System32. Nenhum
processo do usuário foi encerrado.

O executor principal integrou e validou o incremento; `gpt-6.1-sol/high`
implementou o runtime delegado e seus testes, e `gpt-6-astra/high` revisou as
decisões, correções e critérios finais pela skill `codex-advisor`. Não há medição
de custo dos agentes. Foram preparados somente 14 caminhos deste incremento,
preservando os 6.862 registros não relacionados do índice Git. Não houve commit,
push ou publicação. Diagnósticos após escrita, notificações automáticas, status
HTTP/interface e os gates de distribuição pública permanecem abertos. A meta
geral continua ativa.

## Política do operador e diagnósticos explícitos — promovido em 16/10/2026

A política atual substitui as restrições descritas nos relatos históricos.
Os caminhos de permissão V1/V2 usam uma avaliação compartilhada que permite
operações; registros legados `ask/deny` continuam armazenados, mas não ocultam
ferramentas, criam confirmações ou bloqueiam chamadas. Agentes e candidatos da
Arena podem usar ferramentas de edição, comandos e delegação. Restrições no
prompt do usuário orientam o agente, sem compilação automática em bloqueios.

Foram retiradas as proibições por papel dos agentes, lembretes de planejamento
que impunham somente leitura, pedidos de aprovação das descrições revisadas e
negações locais de caminhos externos nas ferramentas nativas. A resolução
canônica, a detecção de mudança de destino e escritas condicionais continuam
verificando a identidade da operação. Sessões ou agentes inexistentes produzem
erro antes da execução; autenticação e isolamento de sessões permanecem funções
técnicas. A base operacional tem quatro linhas neutras; skills e integrações
continuam descobertas sob demanda. A auditoria de todos os hooks, plugins e
instruções ambientais ainda não terminou.

O LSP nativo agora recebe diagnósticos push e consulta pull quando suportado,
com limite de itens, tamanho, documentos, gerações e filas. Resultados atuais
conferem versão, geração e hash físico; publicações sem versão permanecem
explicitamente não confirmadas. O status HTTP autenticado e a interface V2
usam a Location correta e não iniciam servidores ao consultar metadados.
Notificações são agrupadas no evento existente `lsp.updated`. Arquivos externos
podem ser consultados pelo servidor já configurado; URIs retornadas não fazem
o runtime inspecionar seus destinos.

Um servidor TypeScript real expôs um erro no Windows: publicava `file:///c%3A/…`
enquanto o documento admitido usava `file:///C:/…`. O recebimento agora decodifica
a URI de arquivo e compara somente os caminhos já admitidos, sem consulta ao
sistema de arquivos nem criação de novas admissões. Os testes cobrem nomes
Unicode, percent-encoding, caixa da unidade, URIs inválidas e rajadas de destinos
desconhecidos.

Validação do incremento, sem somar conjuntos potencialmente sobrepostos:

- Core geral: 371 testes passaram, 1.759 verificações em 27 arquivos.
- Runtime legado: 151 testes passaram, 666 verificações em 11 arquivos.
- Após a correção de URI: 57 testes focados LSP passaram, 386 verificações;
  a prova adicional de rajada com URIs válidas passou com cinco verificações.
- Interface: 24 testes passaram, 78 verificações em três arquivos.
- SDK Next: sete testes passaram, 50 verificações em três arquivos.
- Core, Server, Opencode, Client, App e SDK Next passaram na checagem de tipos;
  Core e Opencode foram conferidos novamente após suas últimas mudanças.
- Os nove fluxos compilados passaram nas variantes normal e baseline, com
  779 verificações por variante, em 70,17 e 71,00 segundos. Cobrem compactação,
  instruções e recuperação, leitura, MCP/OAuth, origem do contexto, recuperação
  de resultados, TypeScript LSP real e distribuição. Os cenários conferem
  execução apesar de negações legadas e erros de identidade antes de chamadas
  ao provedor. A limpeza de cada fixture também terminou com sucesso.

O motor padrão é `1.18.35+cudia.a1c9471a1874.b8932a136395`, fingerprint
`b8932a1363959a2ebc7e103940d2cfd269da31cb`. Os executáveis normal e baseline têm
138.385.920 bytes e SHA-256
`F80AFC5E0C0FCE5F41F14B55C3FF9B37042E59A5AAC1A69B74DABB21C9757055`.
O catálogo de modelos permaneceu fixado e o fingerprint das fontes foi conferido
após os testes. A igualdade dos binários não comprova funcionamento em CPU antiga.

A primeira tentativa de promoção manteve handles abertos durante a substituição;
o Windows recusou essa operação. Os hashes e o stamp anteriores permaneceram
intactos. Fixtures locais demonstraram a recusa com arquivo aberto, a proteção
do executável em execução e a substituição após encerrar somente o processo de
teste e liberar seus recursos. A promoção corrigida verifica abertura exclusiva,
fecha cada handle imediatamente antes de `MoveFileExW`, verifica cada substituição
e grava o stamp por último. A janela de lançamento entre essas etapas existe;
não há transação atômica global. Falha parcial usa restauração verificada ou é
reportada com a localização do backup, sem encerrar processos do usuário.

A promoção terminou com ambas as versões e hashes conferidos, stamp de 41 bytes
UTF-8 sem BOM e backup verificado em
`packages/opencode/dist-before-policy-e2970d7765934e5eae93862e9163865a`.
O backup preserva o executável anterior `7b1cb2b7c080`, idêntico nas duas variantes,
e seu stamp. Nenhum processo do usuário foi encerrado.

O executor principal integrou o incremento. `gpt-6.1-sol/high` implementou e
validou o runtime LSP, `gpt-6-luna/high` revisou prompts e testes legados, e
`gpt-6-astra/high` revisou decisões, resultados e recuperação pela skill
`codex-advisor`. Não há medição de custo dos agentes. Foram preparados somente
os 114 caminhos deste incremento, preservando exatamente os 6.769 registros não
relacionados do índice Git. Não houve commit, push ou publicação.

Diagnósticos automáticos após escrita, QA visual e do pacote web embutido,
auditoria ambiental restante e distribuição pública continuam abertos.
A meta geral permanece ativa.

## Diagnósticos após escrita — promovido em 16/10/2026

As ferramentas nativas V2 `write`, `edit` e `apply_patch` agora usam um auxiliar
compartilhado após o commit. `FileMutation` conserva sua lógica e seu lock; o LSP
fica na ferramenta que possui o contexto da operação. Todos os caminhos
efetivamente alterados têm seu cache invalidado localmente antes de qualquer
espera. A coleta posterior tem um prazo único de três segundos, até quatro
arquivos elegíveis, vinte diagnósticos e 8.192 bytes de saída serializada,
incluindo prefixo, metadados, escapes e contagens. Mensagens e códigos textuais
são limitados a 512 bytes; truncamentos e omissões são explícitos.

A seleção de extensões reutiliza o resolvedor do runtime e não lê arquivos ou
inicia processos. Arquivos sem suporte não ocupam os quatro lugares de coleta.
Se nenhum arquivo tem suporte, o resultado mantém o formato anterior, sem texto
LSP adicional. Exclusões fecham somente documentos conhecidos, sem consulta de
diagnósticos nem inicialização de servidores. Lotes mistos preservam contagens
de arquivos sem suporte e omitidos.

Falhas esperadas e timeout do LSP são informações suplementares, sem converter
um arquivo confirmado em falha de gravação. Falhas parciais de patch continuam
falhas, com a lista de operações aplicadas e complemento limitado referente
somente a esses caminhos. Defeitos e interrupções são preservados e podem impedir
o complemento; não há garantia de execução exatamente uma vez ou de desfazer
efeitos já gravados. Os relatórios descrevem o arquivo observado na consulta,
inclusive possíveis alterações de outro escritor, e conservam origem, versão,
geração e classificação de frescor. Um relatório sem versão não é prova de
ausência de erros.

O servidor pode demorar mais que três segundos para iniciar. Uma primeira rodada
isolada obteve o diagnóstico automático antes de qualquer consulta explícita.
Na rodada simultânea das duas variantes, a primeira coleta atingiu seu prazo;
o arquivo continuou salvo e o resultado registrou timeout e omissão. A consulta
explícita seguinte recuperou o diagnóstico pelo mesmo processo: o registro de
lançamentos confirmou exatamente um início por fixture. As operações posteriores
de edição, patch, exclusão e escrita receberam seus resultados automáticos sem
timeout. Nenhum prazo de produção foi aumentado para satisfazer os testes.

Evidência do incremento:

- Core geral: 392 testes passaram, 1.822 verificações em 29 arquivos.
- Runtime, diagnósticos, auxiliar e ferramentas LSP: 90 testes passaram,
  581 verificações em cinco arquivos.
- Após o refinamento para extensões sem suporte: os 22 testes afetados passaram,
  com 167 verificações. Incluem escrita e edição com saída exatamente preservada.
- SDK Next: sete testes passaram, 50 verificações em três arquivos.
- Core, Opencode e Server passaram na checagem de tipos; Core e Opencode foram
  conferidos novamente após as últimas mudanças.
- Normal e baseline: nove fluxos compilados passaram em cada variante, com
  829 verificações por variante, em 56,27 e 55,40 segundos respectivamente.
  O cenário TypeScript real usou quinze turnos de um provedor determinístico;
  verifica a ferramenta compilada e não a qualidade de um modelo.
- Os testes também verificam liberação do lock antes do LSP, segundo escritor
  no mesmo arquivo, falha parcial junto de timeout, interrupção, coleta limitada,
  invalidação de todos os caminhos antes de um fechamento bloqueado, cancelamento
  da consulta pendente e preservação da conexão saudável.

O motor padrão agora é `1.18.35+cudia.a1c9471a1874.f1221089da4a`, fingerprint
`f1221089da4a8c0cde86809aed92849331f13692`. Os dois executáveis têm 138.390.016
bytes e SHA-256
`C3B1C910AFD8FB2E6D93D8093135F95ECFE6E77BC685C5553F725CE7A22EF91C`.
O catálogo de modelos permaneceu fixado. A promoção usou o procedimento local
validado no incremento anterior: verificação de hashes, stamp e ausência de
processos nos caminhos padrão, abertura exclusiva para conferir os arquivos,
substituição individual e stamp por último. Essa sequência mantém uma janela
de lançamento e não constitui transação atômica global.

As duas variantes padrão retornaram a nova versão e seus hashes foram
conferidos. O stamp tem 41 bytes UTF-8 sem BOM. O backup verificado de `b8932a136395`
e seu stamp estão em
`packages/opencode/dist-before-postwrite-21d82a0dbc7043f1aefcc4aa0f1bba56`.
Nenhum processo do usuário foi encerrado. A política permissiva do incremento
anterior permanece; esta integração não acrescenta instruções ao prompt fixo
nem novas chamadas ao modelo.

O executor principal integrou as ferramentas e a validação compilada;
`gpt-6.1-sol/high` implementou e testou o auxiliar/runtime, e `gpt-6-astra/high`
revisou a arquitetura, os resultados e o contrato de timeout pela skill
`codex-advisor`. Não há medição de custo dos agentes. Foram preparados somente
os dezesseis caminhos deste incremento, preservando exatamente os 6.870 registros
não relacionados do índice Git. Não houve commit, push ou publicação.

QA visual e do pacote web embutido, auditoria ambiental restante, continuidade
após efeitos interrompidos e distribuição pública continuam no roteiro.
A meta geral permanece ativa.

## Rastreamento de transformações V1 — promovido em 16/10/2026

A auditoria optativa agora mantém um histórico por chamada principal V1 das
projeções instrumentadas dos hooks de mensagens, texto de sistema e
`options.instructions`. No AI SDK, registra também a normalização de mensagens.
Os registros identificam etapa, projeção, ordem de execução, origem observada,
registro do plugin, resultado e hashes anteriores/posteriores. IDs duplicados
conservam registros distintos; alterar e depois restaurar um texto deixa duas
alterações visíveis. A observação acompanha os arrays realmente consumidos e
preserva o comportamento de substituições de envelope que o motor ignora.

Os hooks conservam ordem, argumentos, identidade e falhas. O observador opcional
não transforma um defeito ou cancelamento em sucesso; seus próprios erros não
substituem a saída do hook. A API mutável `list()` permanece: antes de atribuir
uma origem, o runtime confere a referência registrada. Reordenação ou substituição
sem vínculo conhecido recebe `unattributed-plugin-registration`.

O rastreamento fica fora do prompt. Não guarda textos intermediários, headers,
autenticação ou opções arbitrárias. Cada snapshot percorre até 4.096 nós,
profundidade 24 e 64 KiB de codificação tipada. Não chama getters ou `toJSON`;
valores incompletos ficam sem hash e com alteração desconhecida. A codificação
preserva `undefined`, arrays esparsos, números e Unicode; seu hash não é hash dos
bytes de rede. Propriedades não enumeráveis e símbolos ficam fora dessa projeção.
A enumeração interna de JavaScript e traps de Proxy impedem prometer um limite
absoluto de tempo ou um sandbox para plugins.

São mantidos até 64 registros, com limites aplicados antes da coleta de registros
omitidos. Trace e manifests compartilham os 64 KiB de metadados do relatório;
omissões são explícitas e capturas antigas V1/V2 continuam legíveis. Auditoria
desligada não cria o coletor nem calcula esses snapshots/hashes no fluxo principal.
A captura ocorre antes do adaptador: pode ser persistida antes de uma falha do
provedor e não prova aceitação ou conclusão. Falhas anteriores ao ponto de captura
podem deixar o relatório anterior disponível.

Evidências deste incremento:

- Core: 25 testes passaram, 161 verificações, incluindo limites compartilhados,
  omissão integral, tipos não suportados e isolamento de coletores intercalados.
- Plugin, preparação e LLM: 51 testes passaram, 186 verificações em três arquivos.
  Incluem falhas, interrupção de hook pendente, origem desconhecida após reordenação,
  acessores não executados e auditoria desligada com coletor que falharia se chamado.
- A suíte completa de prompt passou com 51 testes, 14 ignorados e 254 verificações.
  Duas expectativas antigas `deny/ask` foram ajustadas ao contrato já permissivo;
  as verificações de persistência e herança dos registros foram mantidas.
- Loader e autenticação foram conferidos junto do LLM: 114 testes passaram em cinco
  arquivos na rodada anterior aos ajustes finais de rastreamento.
- Core, Opencode e Server passaram na checagem de tipos; Opencode foi conferido
  novamente com a fonte final.
- Normal e baseline: dez fluxos compilados passaram em cada variante, com 875
  verificações por variante, em 70,81 e 70,72 segundos. O novo cenário confirma
  restauração do texto, atribuição de IDs duplicados, envelope ignorado, sanitização
  de URL e exclusão dos valores privados testados. Provedores locais determinísticos
  verificam o motor compilado, sem medir qualidade de um modelo remoto.

O motor padrão agora é `1.18.35+cudia.a1c9471a1874.506da3cc60ce`, fingerprint
`506da3cc60ce7f680ed7bbde7f60e6699b0f50fe`. Ambos os executáveis têm 138.397.184
bytes e SHA-256
`6EE2F72732B1A6C3AFC22B26CD2223A18930ED80D13676D1A798E2AEC06E6A10`.
Versões, hashes e stamps de 41 bytes foram conferidos após a promoção. O backup
verificado de `f1221089da4a` e seu stamp estão em
`packages/opencode/dist-before-plugin-trace-e7ad1bc6947b4e8eb72d0c974376faaf`.
A promoção usa substituições individuais e stamp por último, com janela de
lançamento; não é uma transação atômica global. Nenhum processo do usuário foi encerrado.

O executor principal integrou o fluxo V1. Pela skill `codex-advisor`,
`gpt-6.1-sol/high` implementou Core e testes de orçamento;
`gpt-6-luna/high` auditou plugins e preparou o teste compilado;
`gpt-6-astra/high` revisou arquitetura e resultado, identificando as correções de
atribuição e documentação resolvidas antes da promoção. Não há medição de custos
dos agentes. Foram preparados somente os quinze caminhos deste incremento,
preservando exatamente os 6.875 registros não relacionados do índice Git.
Não houve commit, push ou publicação.

A proveniência continua parcial: chamadas auxiliares e de compactação, hooks de
definições/resultados de ferramentas, conversão nativa posterior e transformações
finais dos adaptadores permanecem fora desse histórico. A seleção de editores por
nome de modelo ainda será retirada em incremento separado. A meta geral permanece ativa.

## Catálogo e descrições dos editores V1 — promovido em 16/10/2026

`write`, `edit` e `apply_patch` agora aparecem juntos no catálogo V1 para todos os
nomes de modelo, sem a heurística que escolhia patch para parte dos modelos GPT e
escondia patch para os demais. Seleções explícitas do usuário permanecem; registros
legados de permissão não impõem bloqueios. A disponibilidade real do CodeMode e as
opções existentes dos backends web continuam sendo consideradas.

As três descrições agora apresentam operações e formatos de entrada. Foram
retiradas exigências falsas de leitura prévia, proibições de documentação/emojis
e preferências obrigatórias por edição ou por não criar arquivos. Sobrescrita,
preservação do BOM, correspondência exata, ambiguidade e sintaxe de patch continuam
descritas. O campo `write.filePath` informa corretamente que aceita caminhos
relativos ao workspace. Os cabeçalhos de diagnóstico LSP V1 deixam de ordenar
“please fix” e continuam informando os erros observados.

Os três textos juntos passaram de 3.090 para 1.328 bytes com quebras LF. Isso mede
essas descrições, sem afirmar economia do catálogo inteiro ou de tokens: mais
schemas de editores ficam disponíveis nas famílias antes filtradas.

Verificação:

- 134 testes passaram, 366 verificações em seis arquivos, incluindo registro,
  escrita, edição, patch, preparação e LLM. Um teste antigo do CodeMode ainda
  esperava bloqueio por `deny`; sua expectativa foi corrigida para o contrato
  permissivo, conservando os testes de disponibilidade real.
- Houve uma falha isolada `EFAULT` na limpeza do preload Windows/Bun após os 134
  testes funcionais passarem. A repetição em processo novo passou integralmente,
  sem modificar o preload ou omitir esse erro. O diretório temporário dessa
  execução não foi removido manualmente.
- O registro foi conferido com seis nomes de modelos e schemas executáveis
  equivalentes. Uma escolha explícita `write: false` continua sendo respeitada.
- Dois cenários compilados com provedor local determinístico, nomeados GPT e
  Qwen, usaram caminho relativo, sobrescreveram arquivo existente sem `read`,
  editaram e aplicaram patch, com os bytes exatos conferidos a cada etapa.
  Esses testes verificam o harness; não medem qualidade nem acesso a modelos reais.
- A fonte final passou na checagem de tipos do Opencode.
- Normal e baseline passaram nos doze testes compilados de onze arquivos, com
  920 verificações por variante, em 80,72 e 81,47 segundos.

Uma rodada anterior da baseline recebeu `source: none`, `freshness: pending` na
primeira consulta explícita LSP após o prazo da coleta automática. O mesmo cenário
passou isoladamente. O contrato do runtime permite esse estado; o teste foi
ajustado, após revisão, para permitir até duas novas consultas explícitas de
leitura somente nessa aquisição inicial após timeout. Cada resultado tolerado
precisa indicar pendência, diagnósticos vazios e zero omissões. IDs das chamadas
são únicos, a contagem de turnos é separada da fase e o cenário ainda exige o
diagnóstico 2322 antes de continuar, resultados posteriores estritos e exatamente
um processo. Prazos e código LSP de produção não mudaram. As duas rodadas finais
não precisaram dessas consultas adicionais; essa ramificação não foi exercitada
nessas execuções finais.

O motor padrão agora é `1.18.35+cudia.a1c9471a1874.cbc880767f57`, fingerprint
`cbc880767f5708c75f8d1b64e235128afbb93d0d`. Ambos os executáveis têm 138.395.136
bytes e SHA-256
`B87829610066E098D18616F5BCB7AB926FD040DBF1B394E680810D0E50E23ABC`.
Versões, hashes e stamps de 41 bytes foram conferidos após a promoção, com backup
verificado do motor `506da3cc60ce` em
`packages/opencode/dist-before-editor-catalog-1a46b67c987040d0a855981a7e41eb15`.
O procedimento continua individual por arquivo, com stamp por último e janela de
lançamento. Nenhum processo do usuário foi encerrado.

Pela skill `codex-advisor`, o executor principal integrou o catálogo e as
descrições; `gpt-6-luna/high` preparou os cenários compilados e fez a auditoria
estática seguinte; `gpt-6-astra/high` revisou a decisão, o contrato de pendência
do teste e os resultados finais. Não há medição de custos dos agentes.
Foram preparados somente os treze caminhos deste incremento, preservando
exatamente os 6.878 registros não relacionados do índice Git. Não houve commit,
push ou publicação.

A auditoria seguinte encontrou prescrições em shell, glob, tarefas e listas de
trabalho, além de orientação de carregamento de skills. Sua neutralização e a
proveniência ambiental restante continuam pendentes, junto do instalador final,
QA visual e distribuição pública. A meta geral permanece ativa.

O próximo lote tem evidência estática delimitada: `tool/shell/shell.txt` proíbe
operações de arquivos e fixa regras de Git; `tool/shell/prompt.ts` impõe comandos
prévios, escolhas de utilitários e formato de comandos nos perfis Bash, PowerShell
e cmd. O renderer também chama o shell de persistente, embora `tool/shell.ts`
inicie um processo por chamada. Seu texto de timeout sugere repetir a operação
apesar de possíveis efeitos parciais; a próxima revisão deve informar o resultado
incerto sem prescrever replay. Os contratos de cwd, quoting, sintaxe, prazo e
retenção de saída precisam continuar precisos. `tool/glob.txt`, `todowrite.txt`
e `task.txt` ainda ditam delegação e acompanhamento; a descrição Core de `skill`
contém condição de carregamento além do contrato de busca. A orientação dinâmica
de servidores em `tool/code-mode.ts` requer auditoria de origem separada. Esses
achados são leitura de código ativo, sem afirmar cobertura universal.


## Descrições neutras das ferramentas — incremento validado

As descrições ativas inspecionadas agora apresentam os contratos das operações.
Shell não impõe utilitários, operações prévias, formato de comandos, uso de cd ou
fluxo de Git/PR. O renderer identifica o shell real, distingue PowerShell 5.1 e 7,
informa cwd, prazo e limites de saída e corrige a antiga afirmação de persistência:
cada chamada inicia um processo. O texto de timeout informa resultado incerto e
possíveis efeitos parciais, sem recomendar repetição automática.

Glob informa diretório padrão, caminhos relativos e limite de 100 resultados,
sem ordenar delegação ou buscas especulativas. Alcançar o limite não prova a
existência de resultados adicionais. Task descreve sessões, continuação e retorno
foreground/background; suas mensagens não proíbem consultar progresso ou trabalhar
em determinado assunto. O catálogo deixa de inventar restrição de invocação quando
falta descrição. A retomada com ID inválido ainda cria outra sessão; a recuperação
de identidade e o catchCause desse caminho continuam como dívida separada.

Todo descreve substituição integral, ordem e limpeza por lista vazia. Não impõe
uso proativo nem exatamente uma tarefa em andamento. Status e prioridade são
strings; convenções não se tornaram enums. Skills V1/Core continuam com pesquisa
paginada de nomes/descrições sem carregar corpos e carregamento por nome sob
demanda. A exclusividade entre pesquisa e carregamento é contrato de argumentos.
A descrição Core do Todo também foi neutralizada. Execução, notificações,
autenticação, limites e capacidades implementadas não foram redesenhados neste lote.

Validação:

- Opencode: 153 testes passaram, zero falhas e 517 verificações em oito arquivos,
  incluindo shell real, tarefas/notificações, glob, skills, catálogo e contexto.
- Core: três testes de Skill/Todo passaram, com 18 verificações.
- As checagens de tipos de Core e Opencode passaram; Opencode foi checado novamente
  após a versão final do cenário compilado.
- Cada variante Windows passou nos 13 testes compilados de 12 arquivos, com 978
  verificações; normal em 89,89 segundos e baseline em 87,21 segundos.
- O novo provedor local determinístico confere descrições expostas, cria arquivo
  pelo shell, persiste dois todos in_progress, encontra o arquivo via glob e
  substitui/limpa a lista. O cenário conserva deny legado na configuração.
  Task/Skill têm cobertura de execução nos testes de pacote; o novo cenário
  compilado confere suas descrições. Não houve chamada a modelo real.
- Ambos os cenários LSP terminaram com um processo e 15 turnos. A coleta automática
  inicial atingiu seu prazo, mas não foram necessárias consultas extras de pendência;
  essa ramificação não foi exercitada nessas rodadas.

Durante o preparo dos testes, o fixture Todo precisava do SessionProjector para
materializar a sessão no banco; duas expectativas literais de texto antigo de
Skill também precisaram ser atualizadas. O primeiro cenário compilado usou o nome
shell, mas o identificador público de compatibilidade é bash. Depois, o PowerShell
imprimiu um redirecionamento sem espaço como texto. O fixture final seleciona
Set-Content com UTF-8 para PowerShell e redirecionamento separado nos demais
shells, tolerando o BOM de UTF-8. Essas correções não alteraram o runtime de execução.

O motor padrão passou a ser 1.18.35+cudia.a1c9471a1874.c8c988f449cd,
fingerprint c8c988f449cd279fbfde1a02cefa17c39e9997d1. Os dois executáveis
têm 138.377.728 bytes e SHA-256
6B57ABAE4A6269641667320D255CB99F9720DFF71D75D23F1F9174B9003D20BE.
Após a promoção foram conferidos versões, hashes, tamanhos e stamps de 41 bytes.
O backup verificado do motor cbc880767f57 fica em
packages/opencode/dist-before-neutral-tools-ae2df40e02744cc69a5a8c05c9cfd5f8.
A troca continua individual por arquivo, com stamp por último e janela de
lançamento; nenhum processo do usuário foi encerrado.

Pela skill codex-advisor, gpt-6-luna/high implementou o renderer e seus testes;
o executor principal integrou os demais contratos e a validação;
gpt-6-astra/high revisou a decisão inicial e os resultados finais.
Não há medição de custo ou economia total de tokens dos agentes. Foram preparados
somente os 19 caminhos deste incremento, preservando exatamente os 6.875 registros
não relacionados do índice Git. Não houve commit, push ou publicação.

Essa entrega encerra o lote de descrições inspecionadas. A auditoria ambiental,
orientações dinâmicas de integrações e transformações posteriores ao pedido
preparado ainda exigem cobertura adicional. QA visual, instalador profissional,
publicação assinada e atualizações públicas continuam pendentes. A meta geral
permanece ativa.


## Próxima correção de integração: GitLab Workflow

A leitura do código ativo encontrou estado compartilhado que requer uma correção
conjunta antes de declarar isolamento dessa integração. Provider.getLanguage
armazena modelos por providerID/model.id. GitLabWorkflowLanguageModel mantém
sessionID, systemPrompt, toolExecutor e approvalHandler mutáveis. Seu doStream
aguarda resolveModelRef antes de capturar parte desse estado e aguarda o token
antes de ler sessionID. Um probe local posterior reproduziu o cruzamento na
dependência gitlab-ai-provider 6.19.0: duas chamadas reais de doStream foram
suspensas na resolução do modelo, com a configuração da segunda aplicada enquanto
a primeira aguardava. Ao continuar, a chamada A consultou a chave de sessão B.
O probe interrompeu o fluxo antes da criação remota, com zero chamadas de rede;
a ligação desse comportamento ao cache do host foi inspecionada separadamente.
Isso demonstra a corrida da dependência compartilhada, sem afirmar um teste de
integração com o serviço GitLab real.

O caminho de aprovação do host também lê regras ask legadas para selecionar
sessionPreapprovedTools e cria uma ponte de permissões hoje inerte. A dependência
já incorpora os nomes aprovados ao pedido seguinte: o host não precisa manter
outro conjunto acumulado. Existem operações remotas e um fallback interno para
algumas ferramentas desconhecidas; um teste do executor do host não prova controle
universal dessas operações.

A revisão independente orientou tratar isolamento e remoção dessa ponte juntos:
instâncias pertencentes à sessão/provedor/modelo dentro do ciclo de configuração
e Location, continuidade dos IDs remotos, concorrência da mesma sessão definida,
retenção limitada e descarte após remoção/reconfiguração. Os testes devem suspender
operações reais da dependência para intercalar chamadas e conferir identidade,
prompt, executor e estado de aprovação. Um callback de aprovação sem estado é
suficiente no host. Essa implementação permanece pendente; a correção de retomada
da ferramenta task é independente e foi validada no incremento abaixo.


## Retomada de tarefas com identidade explícita — incremento validado

A ferramenta task deixou de transformar falhas de lookup em novas sessões. Antes,
o catchCause abrangente descartava falhas de lookup; um ID inexistente ou defeito
podia selecionar a criação de outra tarefa. Agora qualquer task_id
informado, inclusive string vazia, passa pela busca; erros seguem a fronteira de
erro existente da ferramenta. Omitir o campo continua criando uma sessão filha,
e uma sessão existente continua pelo mesmo ID. Não foram introduzidas restrições
de assunto, papel, caminho ou propriedade de sessão.

As descrições e o README refletem o novo contrato. Os testes verificam ID ausente
no banco e string vazia, zero filhos e nenhuma execução de prompt após falha,
preservação do mesmo objeto de defeito e interrupção durante lookup pendente.
O teste de interrupção usa uma barreira de prontidão, interrompe a fibra real
e confirma a causa de interrupção. Retomada válida, criação sem ID, notificações
e cancelamento continuam cobertos pelos testes existentes.

Validação da fonte: 89 testes passaram, com 14 skips existentes, zero falhas e
434 verificações em quatro arquivos de Task/Arena/Prompt/contexto; 47,69 segundos.
A checagem de tipos do Opencode e a formatação passaram.

O novo cenário compilado usa provedor local determinístico e quatro turnos do
coordenador mais dois da sessão filha. Primeiro, o resultado do ID inexistente
aparece no pedido seguinte e o endpoint de filhos retorna lista vazia. Uma criação
explícita gera um único filho; a chamada seguinte usa exatamente seu ID. O cabeçalho
de sessão e o histórico conferem a mesma identidade, com o primeiro prompt,
primeiro resultado e segundo prompt, sem copiar o prompt do coordenador.
O cenário passou isoladamente com 34 verificações em 6,97 segundos.
Não houve chamada a modelo real.

A suíte compilada completa passou nas duas variantes: 14 testes em 13 arquivos,
1.012 verificações cada, normal em 118,93 segundos e baseline em 119,70 segundos.
Os dois testes LSP tiveram um processo, 15 turnos e nenhuma consulta adicional
de pendência; a ramificação adicional não foi exercitada nessas rodadas.

Motor padrão: 1.18.35+cudia.a1c9471a1874.5f99af974c16.
Fingerprint: 5f99af974c1633fd48e8946973ac6883e463b797.
Os dois executáveis têm 138.377.728 bytes e SHA-256
0214E0279EA742ED493C2160AB5BC22934EF0EDAE00E92F57C7F41978E242A48.
Versões, hashes, tamanhos, stamps de 41 bytes e backup foram conferidos após a
promoção. Backup anterior:
packages/opencode/dist-before-task-continuation-005f950c80274082b922a6f1eec92728.
O procedimento troca arquivos individualmente, mantém a janela de lançamento e
grava o stamp por último. Nenhum processo do usuário foi encerrado.

Pela skill codex-advisor, gpt-6-luna/high implementou Task e seus testes;
o executor principal fortaleceu as verificações e integrou o cenário compilado;
gpt-6-astra/high revisou o contrato, a separação da integração Workflow e os
resultados finais. Não há medição de custo dos agentes. Com a correção posterior
do teste de interoperabilidade, os sete caminhos deste incremento preservam os
6.888 registros não relacionados do índice Git. Não houve
commit, push ou publicação; a meta geral permanece ativa.

A auditoria de distribuição confirmou que package.ps1 recebe EnginePath e não
recompila o motor; um pacote novo precisa selecionar explicitamente este artefato.
Os trust.json do launcher e serviço continuam vazios e o diretório de releases
não contém uma release pública. Os helpers locais de 15/10 não são um instalador
de produção. O builder do wizard já exige chaves de confiança e mantém
validatedForPublication false. Provisionamento de chaves, publicação, QA interativa
e Windows limpo continuam como trabalhos da entrega final.


Verificação pública desta rodada: em 16/10/2026 às 05:05:51 UTC, consultas HEAD
a https://cyara.com.br/updates/v1/stable.json e https://cyara.com.br/health retornaram
404 com Content-Type text/html, sem redirecionamento. Isso verifica indisponibilidade
nesses caminhos; não determina sozinho o estado da configuração ou do deploy na
Hostinger. A ferramenta de leitura web não conseguiu abrir esses endereços; a
observação HTTP foi obtida diretamente com Node.js 22, sem alterar o servidor.


### Distribuição testada com o motor deste incremento

A suíte Windows foi executada com Node.js 22, Go 1.27.2, PowerShell 5 e Inno 7.1.0,
usando exatamente o executável de SHA-256 0214E0279EA742ED493C2160AB5BC22934EF0EDAE00E92F57C7F41978E242A48.
Todos os temporários e o Registro das fixtures foram isolados. O teste do wizard
compilou um instalador de teste, instalou/reexecutou/desinstalou, conferiu o PATH,
iniciou o motor de outra pasta com PATH mínimo e validou recuperação nos pontos
de interrupção e restauração. O banco SQLite e os bytes existentes de WAL/SHM
de uma sessão ociosa foram preservados. Foram encerrados somente processos
criados pelas próprias fixtures. Não houve instalação no perfil real do usuário.

A execução inicial de seis testes teve cinco aprovações e uma falha em 342,22
segundos. O wizard passou em 291,80 segundos. A falha de interoperabilidade era
uma expectativa antiga de Arena somente leitura, incompatível com a orientação
atual: o candidato permitia edit, mas o teste exigia false. O teste foi corrigido
para exigir read/edit/bash/task disponíveis, inclusive sob uma configuração do
usuário com deny legado. Não houve mudança no runtime do instalador ou motor.

A repetição apenas da interoperabilidade passou em 31,77 segundos. Suas demais
verificações permaneceram: assinatura, pacote, defaults abaixo da configuração do
projeto, ausência de dependências de desenvolvimento, preparo/ativação/removal,
atualização por versão enquanto o servidor antigo continua ativo, retenção da
sessão existente e seleção da versão nova na abertura seguinte. Os cinco testes
não afetados não foram repetidos; não se trata de uma segunda rodada unificada
dos seis testes. As chaves e o instalador dessa fixture eram exclusivos do teste.
Isso não configura release de produção, assinatura Authenticode, QA visual ou
validação em Windows limpo.

O teste de interoperabilidade fica fora dos caminhos usados no fingerprint do
motor; sua correção não exige recompilar esse executável. Versão e fingerprint
5f99af974c1633fd48e8946973ac6883e463b797 continuam sendo a referência local.
O executor principal corrigiu essa expectativa e executou a validação;
gpt-6-luna/high auditou somente a preparação de distribuição, sem publicar ou
provisionar chaves. A meta geral permanece ativa.


### GitLab Workflow: isolamento, continuidade e aprovação legada — 16/10/2026

O modelo compartilhado pelo cache do provedor deixou de receber os dados mutáveis
por chamada. O runtime adquire uma instância própria por sessão/provedor/modelo,
com uma fila para chamadas da mesma sessão. Sessões diferentes continuam em
paralelo. O cache padrão dos demais modelos permanece em uso; a fábrica Workflow
usa a opção explícita de construção sem cache.

O fim normal preserva a identidade remota e remove prompt e callbacks da chamada.
O sinal anterior é encerrado antes de entregar o modelo à próxima chamada.
Cancelamento, falha, saída antecipada, exclusão e descarte da instância aposentam
o modelo afetado. Exclusão ou descarte durante uma fábrica pendente não recria
a entrada quando a resposta chega; o objeto órfão é encerrado. As referências de
espera são contadas para que cancelar um candidato da fila não altere o dono
ativo e para que entradas vazias liberem capacidade.

A aprovação baseada em Permission, eventos e regras legadas foi retirada desse
caminho. Todas as ferramentas preparadas entram na lista preaprovada, mesmo com
ask/deny legados. O callback de aprovação autoriza a chamada atual sem analisar
os argumentos como uma nova política. A verificação de identidade de chamadas
encerradas impede callbacks antigos de usar os dados de outra chamada. Isso não
impõe restrições por tema, ferramenta ou papel de agente.

A retenção tem limite operacional de 128 entradas por instância, configurável
por CUDIA_WORKFLOW_SESSION_LIMIT. Entradas existentes continuam acessíveis quando
a capacidade se esgota; não há expulsão silenciosa de identidades remotas.

O patch versionado de gitlab-ai-provider 6.19.0 cobre cancelamento entre as etapas
assíncronas de preparação, conexão, aprovação e reconexão. Os dois entry points,
ESM e CJS, foram exercitados e suas funções corrigidas comparadas. Um pedido de
criação remota já emitido não é desfeito: os guardas evitam a conexão e o início
posteriores quando o cancelamento é observado. Os testes usaram a classe real e
transportes locais controlados, sem autenticação ou tráfego ao serviço GitLab.
O caminho especial continua fora da captura completa de contexto descrita acima.

Validação final: 164 testes passaram, sem falhas, com 523 assertivas em cinco
arquivos; bun run typecheck e a formatação passaram. A instalação com lockfile
congelado e scripts desativados confirmou as dependências sem mudanças.
As duas variantes compiladas passaram nos 14 fluxos V1/V2, com 1.012 assertivas
por variante. A primeira execução normal teve 13 aprovações e uma falha por
persistência de diagnósticos LSP pendentes além das duas consultas da fixture.
Sem mudança de fonte, o LSP isolado passou com 105 assertivas em 10,36 segundos,
e a suíte normal completa, sem a concorrência anterior, passou em 85,30 segundos.
A baseline passou em 93,95 segundos. Isso não prova a causa da variação temporal;
a falha inicial e os logs foram preservados. As execuções finais tiveram zero
consultas de recuperação inicial, portanto esse ramo não ganhou nova cobertura.

O teste de interoperabilidade de distribuição passou em 34,53 segundos com esse
motor: pacote/manifest assinados por chave da fixture, instalação, ativação,
atualização enquanto o processo anterior continua ativo e retenção da sessão.
Não foram repetidos o wizard completo nem os demais gates de produção nesta rodada.

O diretório padrão agora contém 1.18.35+cudia.a1c9471a1874.e703d2d44076, fingerprint
e703d2d44076c4d9dbceaaf754abc0eda585f55d. Cada variante tem 138.381.312 bytes e
SHA-256 606F67E07AE52E38224527ACBD895C6874D2528C6966A04A4585F738C45BC693.
Versões, hashes e stamps foram conferidos depois da promoção; o backup verificado
preserva o motor 5f99af974c16. Nenhum processo do usuário foi sinalizado.

Pela skill codex-advisor, gpt-6-luna/high implementou a opção de fábrica e os testes
iniciais da dependência e do gerenciador; o executor principal integrou o ciclo
de vida, fortaleceu os testes e validou os builds; gpt-6-astra/high revisou a
arquitetura e exigiu encerrar o sinal anterior antes de liberar a fila. Os 13
caminhos deste incremento preservam os 6.887 registros não relacionados do índice.
Não houve commit, push ou publicação. A meta geral permanece ativa: proveniência
restante, auditoria ambiental, QA da interface e distribuição de produção ainda
não estão concluídas.

### Proveniência da distribuição, rollover e wizard interativo — 16/10/2026

O builder Go agora emite client-build.json com hashes e tamanhos das fontes
copiadas, script, executável Go, resultados e identidade completa do keyring
compilado, além de versão e parâmetros de compilação. O recibo público não contém
caminhos absolutos ou chave privada. Ele descreve os inputs copiados e as quatro
variáveis de compilação definidas pelo script, sem declarar ambiente hermético,
inventário completo do toolchain ou reprodutibilidade byte a byte.

O empacotador vincula esse recibo opcional ao launcher e registra o inventário
efetivo de defaults, motor e launcher dentro do ZIP assinado. O builder do setup
confere identidade, inventário exato, digests, bootstrap e confiança compilada.
Pacotes antigos sem recibo continuam com ausência explícita. A origem das fontes
do motor permanece not-recorded; selecionar um executável não comprova sua origem.
O novo RELEASE-RUNBOOK.md documenta custódia, validade, sequência e gates abertos.

Com Node.js 22, Go 1.27.2, PowerShell 5 e Inno 7.1.0, a rodada inicial dos nove
testes teve oito aprovações e uma falha em 120,75 segundos. O helper do wizard
retornou Acesso negado antes da compilação. Os mesmos inputs passaram depois em
PrepareOnly; a repetição isolada do wizard passou em 280,58 segundos, incluindo
motor real, preservação de SQLite/WAL/SHM e 16 retomadas após quedas. A causa da
primeira falha não foi demonstrada; os logs e a fixture foram preservados.

O rollover A → A+B → B passou com o motor real em 33,41 segundos, sem mudar os
bytes do bootstrap, conferindo rejeições e preservação do estado após falha.
Retirar A afeta o launcher ativo: rollback explícito para versão anterior pode
restaurar seu keyring. Isso não constitui revogação permanente de versões locais
nem valida entrega HTTPS ou migração de ABI.

Foram acrescentados casos de inventário omitido/excedente e ausência legada de
proveniência. A primeira execução desses casos revelou uma dependência de assembly
ausente no helper PowerShell do teste; depois de carregar System.IO.Compression,
os dois testes do builder passaram em 35,80 segundos. Os casos autenticados com
inventário incoerente ou bootstrap falso são rejeitados. Não se trata de uma
segunda execução unificada dos nove testes. Formatação e diff-check passaram.

A QA interativa usou uma exportação CUDIA TEST com hashes verificados e namespace
HKCU próprio. Foram conferidos welcome, cancelamento com confirmação e fechamento,
destino temporário, tarefa de PATH, resumo, instalação e conclusão em português.
cmd /d /c cudia --version, em outra pasta com caracteres não ASCII e PATH mínimo,
retornou 1.18.35+cudia.a1c9471a1874.e703d2d44076. O helper instalado concluiu a
remoção; comando e entrada de PATH privados sumiram e os hashes de Environment,
Cudia e CudiaPreview reais permaneceram iguais. O namespace de teste foi removido.
A primeira tentativa de limpeza usou por engano o helper exportado, que retornou
invalid JSON por não ser o helper registrado nem possuir journal de recuperação;
não houve mudança no runtime para contornar essa identidade.

O setup TEST tem SHA-256 53c9305072173da04ac3624d1c9540ae39531ab5f4175e632dc6bbf0cec5f34d.
Esse resultado não comprova Windows limpo, perfil de produção ou assinatura de
editor Authenticode. A exportação tem manifest de teste com validade finita;
não é uma release pública. Não foram criadas chaves autoritativas ou publicados
artefatos. A aba acessível da Hostinger está no login; configuração/deploy aguardam
essa sessão. /health e /updates/v1/preview.json retornaram 404 às 05:53:20 UTC.

Pela skill codex-advisor, gpt-6-luna/high implementou o recibo do cliente e seu
teste e a fixture inicial de rollover; o executor principal integrou os recibos,
fortaleceu os testes e realizou a QA. gpt-6-astra/high revisou a arquitetura e os
critérios de validação. A meta geral permanece ativa.

A revisão final confirmou o encerramento deste incremento limitado, preservando
a falha inicial sem causa demonstrada e os gates de produção ainda abertos. Os
11 caminhos preservam os 6.892 registros não relacionados do índice Git; não houve
commit, push ou deploy. Fingerprint, stamps e SHA-256 das duas variantes padrão
continuam correspondendo ao motor e703d2d44076. Nenhum processo do usuário foi
encerrado e nenhuma política do runtime foi alterada neste incremento.

## Incremento dos fontes — MCP V1 sob demanda

- [x] Eliminar conexão automática ao ler configuração/status/catálogo nos dois modos.
- [x] Manter conexão, ferramentas e instruções acessíveis por chamada explícita.
- [x] Retirar promoção automática de instruções MCP para o prompt de sistema.
- [x] Corrigir limpeza stdio durante cancelamento e descarte da instância.
- [x] Validar 89 testes e os typechecks de opencode/tui; revisão independente concluída.
- [ ] Compilar e qualificar distribuição posterior à Preview 9 com este incremento.

Detalhes e limites: [MCP-ON-DEMAND.md](MCP-ON-DEMAND.md). A Preview 9 continua publicada
e utilizável; este registro descreve uma mudança posterior somente nos fontes.
