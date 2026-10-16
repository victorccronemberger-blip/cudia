# Histórico opcional de contexto

Incremento em fonte posterior à Preview 12. O instalador publicado continua na
Preview 12; esta função será distribuída em um próximo lote validado.

O histórico conserva metadados de capturas preparadas para chamadas do provedor.
Não acrescenta instruções ao modelo, não muda permissões e não grava o texto de
instruções ou mensagens no histórico. IDs, hashes, contagens, nomes de ferramentas
e origens continuam sendo dados locais potencialmente sensíveis.

## Ativação e leitura

É necessário habilitar ambos `CUDIA_CONTEXT_AUDIT=summary` (ou `content`) e
`CUDIA_CONTEXT_AUDIT_HISTORY=true` no ambiente do processo. Com a auditoria
desligada, a opção de histórico não cria o armazenamento. O módulo é importado
somente no caminho habilitado ou durante uma consulta explícita.

```text
cudia debug context --history
cudia debug context --history --session-id ses_EXEMPLO --limit 10
cudia debug context --history --before 42 --limit 10
```

`nextBefore` fornece o cursor para a página seguinte. A ordem é a sequência de
inserção SQLite, sem promessa de ordem de execução entre processos. Totais,
contagem de itens removidos e limites são globais, inclusive quando há filtro por
sessão. As opções `--content` e `--status` pertencem à consulta da última captura,
não à consulta do histórico.

O arquivo `cudia-context-history.sqlite` fica no diretório de estado do runtime,
separado do banco de sessões e das migrações da aplicação. A última captura
existente continua em seu arquivo próprio e pode conter texto quando o operador
escolhe `content`. Essa escolha não habilita texto no histórico.

## Retenção e falhas

O histórico conserva até 256 capturas e 16 MiB de payload UTF-8, com até 128 KiB por
captura. A inserção e a remoção das mais antigas compartilham uma transação
imediata. Uma captura grande demais é descartada sem apagar as anteriores.
Consultas retornam até 20 itens e têm orçamento de saída de 1 MiB.

O banco principal tem alvo máximo de páginas de 32 MiB e recuperação incremental
de espaço. Esse alvo não limita todo o espaço físico ocupado por journals,
metadados do sistema de arquivos ou arquivos externos. O busy timeout é de 100 ms
por espera, dentro de um prazo cooperativo de 2 segundos para a operação. Esse
prazo não é uma garantia de interrupção imediata de chamadas nativas síncronas.

Falhas do histórico não impedem a chamada ao provedor. A última captura e o
histórico têm persistência independente; interrupções do chamador são propagadas.
O arquivo é conferido antes de alterar configurações persistentes ou tabelas;
bancos de outra aplicação ou versão incompatível são rejeitados.

Isso é um registro limitado de capturas persistidas com sucesso, não um log
completo de execução. IDs explícitos são preservados; lacunas podem significar
retenção, auditoria desligada ou falha de persistência. Finalidade ausente
continua não classificada; os chamadores instrumentados do V1 e V2 fornecem
finalidade explicitamente. O adaptador Node tem checagem de tipos; os testes de
execução deste incremento foram feitos com Bun. Não foi acrescentado um teste de
cancelamento com histórico habilitado; os testes existentes de cancelamento do
runner não demonstram essa combinação específica.

## Origens no histórico selecionado V1

`historySnapshot` observa os resumos concluídos selecionados após os hooks e antes
da conversão de mensagens. Inclui IDs observados de mensagem e parte, posições na
entrada, hashes e bytes UTF-8. IDs após hooks são referências observadas; não
constituem uma nova consulta ao banco nem comprovam autoria de plugins.

Seu identificador local acompanha a captura final sem entrar no pedido do
provedor. `captureID` diferencia capturas que compartilham o mesmo snapshot, como
em repetições. Relatórios anteriores e chamadas sem coletor conservam
`mapping: unmapped-after-conversion`. Nas chamadas principais instrumentadas,
`prepared` informa por fonte a posição observada ou a ausência desse vínculo;
o coletor do SDK está descrito abaixo. Resumos V1 continuam sem mapeamento final.
Não há atribuição por igualdade de texto, inclusive com conteúdo idêntico.

São conservadas até 128 fontes; contagens e bytes incluem as demais, e
`omittedSources` informa exclusões por quantidade ou orçamento. Seus metadados
compartilham 64 KiB com manifests, outras fontes e trace. Texto opcional usa o
mesmo orçamento de conteúdo de 64 KiB e não entra no histórico de metadados.
Chamadas sem auditoria não coletam esse snapshot.

Os loaders V1 de skills e de guidance MCP acrescentam um recibo técnico em
`metadata.contextSource` do resultado local, inclusive quando a auditoria está
desligada. Isso permite conferir a origem posteriormente. O texto devolvido pela
ferramenta e seu schema permanecem iguais. Pesquisar o catálogo não cria recibo
de corpo; guidance é obtido somente pela operação explícita `instructions`.

No snapshot, `source: loaded-tool-result` identifica o resultado armazenado de
uma dessas invocações. `tool` conserva o nome, call ID e a observação do recibo.
O hash e os bytes da fonte descrevem o resultado armazenado inteiro; o descritor
`body` descreve somente o corpo carregado dentro do wrapper. Para skills, usa
intervalos UTF-16; para MCP, o membro JSON `instructions`, após decodificação.
Os hashes do recibo usam `json-utf8`, distinguindo inclusive surrogates isolados;
os hashes gerais do relatório continuam descrevendo bytes UTF-8 do texto observado.

`matched` comprova correspondência entre recibo e resultado armazenado, sem
autenticar o arquivo, o servidor ou a autoria. Plugins podem substituir ambos.
`changed`, `invalid`, `missing` e `unavailable` não conservam uma origem ou um corpo
como verificados. Truncamento ou edição depois do loader produz divergência;
omissão ou recorte na conversão posterior continua fora dessa prova.

## Skills no V2

O loader V2 de skills também produz recibos locais. O vínculo passa pela identidade
do objeto retornado ao executor canônico e é consumido uma vez, antes da codificação
do resultado. O schema e o texto da ferramenta enviados ao modelo não recebem esse
vínculo. O evento existente de sucesso persiste `contextSources` junto do resultado;
replay conserva ambos, e eventos antigos continuam aceitos sem esse campo opcional.

Cada resultado conserva até oito recibos e 16 KiB de metadados, com contagem dos
recibos omitidos. Os índices referem-se à projeção original da ferramenta. Se o
limitador substituir essa projeção, `projection: replaced` explicita que os índices
não estão mapeados para o resultado reduzido. A auditoria não atribui uma origem
verificada nesse caso, nem quando o resultado estiver marcado como podado.

O snapshot V2 observa apenas skills carregadas por nome e concluídas no histórico
selecionado. Confere o texto realmente armazenado e registra o índice de conteúdo,
além dos IDs de mensagem/chamada. Pesquisa de catálogo, falhas e outras ferramentas
não são classificadas como corpos de skills. Texto removido conta como fonte
omitida; resultados antigos sem recibo têm observação `missing`. A captura continua
opt-in, com os mesmos limites compartilhados e `unmapped-after-conversion`.

Este incremento não cobre todos os demais loaders. Não autentica arquivos ou
plugins, nem comprova que o adaptador enviou
cada parte observada. Permanece em fonte, fora do instalador Preview 12.

## Recursos MCP no V2

A operação explícita `mcp` com `operation: read` também produz recibos locais para
as partes de texto. A conexão e as pesquisas de catálogo não leem recursos nem
criam recibos de corpo. O recibo usa `kind: mcp-resource` e um intervalo UTF-16 do
texto dentro do resultado renderizado. Seu `origin` é o JSON determinístico de
`{server, requestedURI, uri}`: servidor observado, URI pedida e URI devolvida em
cada parte. URIs diferentes e corpos iguais continuam distinguíveis. Esses IDs
observados não autenticam a propriedade ou autoria do recurso.

O texto e os schemas enviados ao modelo conservam o formato anterior. Os recibos
seguem o mesmo vínculo local por identidade e o evento de sucesso usado pelas
skills. As primeiras oito partes textuais podem receber recibos; as restantes
contam em `omitted`. Origens acima de 1 KiB ou textos acima do limite de verificação
também podem ficar sem recibo, sem impedir a leitura. Mesmo quando todos forem
omitidos, o resultado conserva essa contagem. Partes binárias não têm recibos de
texto e não contam como omissões de recibos textuais.

Para uma projeção original, a auditoria identifica texto/binário pelo resultado
estruturado validado e preserva os índices reais. Campos ausentes, estrutura
inconsistente, projeção substituída ou poda deixam a atribuição indisponível;
não há reconhecimento do tipo ou da origem por igualdade de texto. Recibos
correspondentes também são conferidos contra o servidor e as URIs armazenados.
O histórico SQLite guarda apenas os metadados, inclusive contagens de omissão.

Os testes incluem leitura HTTP local, partes mistas, limites, reconstrução da
sessão, histórico SQLite e equivalência do corpo codificado do adaptador Responses
com/sem recibos. Isso não é uma captura de rede de todos os provedores. O vínculo
com cada parte final após conversão permanece pendente.
Este incremento continua fora do instalador Preview 12.

## Guidance MCP no V2

`mcp` com `operation: instructions` e `server` consulta as instruções recebidas na
inicialização da conexão atual. O servidor precisa já estar conectado. A consulta
não conecta, renova autenticação, atualiza catálogos ou faz RPC; o conteúdo não é
acrescentado automaticamente ao sistema, à descoberta ou ao resultado de outras
ferramentas. A descrição da operação faz parte do contrato de ferramentas.

O resultado é `{server, instructions}` quando há uma string, preservada exatamente,
inclusive espaços e string vazia. Uma conexão sem esse campo retorna apenas
`{server}` e não produz fonte de guidance. A string vazia recebe um recibo válido
de corpo com zero bytes. Recibos locais `mcp-guidance` verificam o membro JSON
`instructions`, com o servidor como origem observada. A auditoria confere também
os dados estruturados e o servidor solicitado; dados malformados, poda ou projeção
substituída não conservam origem verificada.

Sessão, localização e identidade da conexão são conferidas antes e depois da
consulta. Reconectar não reaproveita instruções de uma conexão anterior. Os testes
incluem trocas de conexão e exclusão da sessão na conferência posterior ao getter.
Guidance maior que o limite do recibo continua disponível no artefato do resultado
quando o limitador genérico reduz a saída; a omissão do recibo fica registrada.

O limite do cliente para uma resposta de recurso MCP é de 8 MiB; é independente
dos 2 MiB aceitos pela inspeção de recibos. Nenhum desses valores é uma promessa de
limite global de armazenamento, memória, rede ou contexto do modelo.

A inspeção aceita até 2 MiB de resultado, 1.024 bytes no identificador de origem
e 4 KiB no recibo projetado. Limites ou ausência do recibo afetam somente a
atribuição; não impedem carregar ou devolver o resultado. Propriedades desconhecidas
não são serializadas e accessors não são executados durante a inspeção.
Resultados de loaders compartilham o limite de 128 fontes e os orçamentos de
metadados/conteúdo dos resumos. O texto do resultado só entra na captura de
conteúdo explícita e é removido do histórico de metadados. A cobertura abrange
skills/guidance MCP V1 e skills/recursos/guidance MCP V2; outros loaders permanecem
fora dela. Não constitui rastreabilidade universal ou autenticação dos produtores.

## Partes preparadas pelo V2

Nas chamadas principais V2, o snapshot acompanha a conversão canônica até o
pedido preparado. O coletor existe somente com auditoria habilitada e observa
as cópias síncronas de `Message.tool`, da mensagem assistant e de `LLM.request`,
conferindo ordem, quantidade, papel e estrutura. Não procura partes por igualdade
de texto nem por call ID. O texto confere uma posição já identificada.

`mapping: observed-at-prepared-request` informa esse modo de observação; cada
fonte tem seu próprio `prepared`, com a posição final ou um motivo explícito de
ausência. Cópias não observadas, substituições nativas, mudanças de estrutura e
ocorrências ambíguas não recebem mapeamento. Um resultado reduzido pode ter posição
conhecida sem ter origem de corpo verificada: `prepared` e `tool.observation`
respondem a perguntas distintas.

Os índices são metadados locais, sujeitos aos mesmos limites de retenção; não
entram no pedido do provedor. Relatórios anteriores continuam legíveis. V1,
compactação e transformações posteriores nos adaptadores permanecem fora dessa
atribuição; não é uma captura do tráfego enviado ao provedor.

Os testes deste mapeamento incluem os construtores reais, saídas idênticas com e
sem coletor, textos/call IDs repetidos, mídia com texto, substituição nativa,
cópias não observadas, invalidação sem recuperação por aliases antigos e os
resultados de skill/recursos/guidance no runner. A regressão integrada passou com
320 testes e 1.892 verificações em 28 arquivos; Core/OpenCode passaram nos tipos.

## Partes preparadas pelo SDK no V1

Nas chamadas principais V1, o conversor registra os resultados selecionados de
skill/guidance MCP no callback real `toModelOutput` do SDK. O vínculo usa a
identidade do objeto de entrada, observado no resultado canônico, e depois a
identidade do objeto textual devolvido pelo renderer. O renderer mantém uma
invocação e o mesmo resultado. IDs e texto conferem uma origem já localizada;
não escolhem entre entradas repetidas.

Antes da conversão, o coletor confere reutilização da entrada entre todos os
resultados canônicos, inclusive ferramentas que não geram recibo. Entradas
compartilhadas são ambíguas. O pedido final preparado depois de
`ProviderTransform.message` é percorrido por identidade, acompanhando texto
simples e texto aninhado em conteúdo com anexos, sem acrescentar campos ao SDK.
Projeção reduzida, normalização que altere o texto, cópias externas e repetições
do mesmo objeto não recebem mapeamento válido.

A cobertura dessa etapa é do SDK V1 principal e dos loaders selecionados. Entradas
primitivas ficam explicitamente sem suporte; resumos permanecem sem vínculo
observado. A validação HTTP compara o corpo codificado byte a byte com a
auditoria ligada/desligada em ambos os caminhos; isso não atribui identidade às
partes depois da serialização nem estende a prova a todos os provedores.
Passaram 112 testes e 447 verificações em seis arquivos, com um skip preexistente
de API key no fluxo nativo gravado; o pacote também passou na checagem de tipos.

## Cópias do adaptador nativo V1

O adaptador nativo também acompanha texto simples de skill/guidance já observado
pelo renderer do SDK. A associação começa na identidade desse objeto e passa
pelas cópias imediatamente observadas de `Message.make`, `LLM.request` e
`LLMRequest.update`. Cada passagem confere quantidade, papel, tipo, nome e ID;
uma divergência invalida a fonte, inclusive seus aliases anteriores. O pedido
preparado é percorrido por identidade e conserva as ocorrências repetidas como
ambíguas. A interface do adaptador contém somente essas observações e é local
à chamada, sem dependência de serviços de sessão.

Essa etapa cobre resultados textuais. A conversão nativa atual de conteúdo com
anexos para JSON permanece igual e recebe `unsupported-result`, sem atribuir uma
posição textual. Resumos continuam sem vínculo final: um ensaio real confirmou
que até o objeto retornado por `convertDataPart` é copiado na preparação do SDK.
Esse caminho experimental não foi incorporado ao conversor. Os índices de
origem permanecem explícitos no snapshot, sem reconstrução por texto.
Na regressão dessa etapa passaram 115 testes e 468 verificações em seis arquivos,
com um skip preexistente de API key; a checagem de tipos também passou. O teste
HTTP nativo confere a posição após `LLMRequest.update` e conserva igualdade byte
a byte com a auditoria desligada.

## Validação

Os testes cobrem exclusão de texto e campos desconhecidos, retenção por bytes e
quantidade, paginação, arquivos incompatíveis, falha de transação, contenção,
dois processos concorrentes e encerramento antes do commit. A integração usa um
provedor HTTP local e compara exatamente mensagens e ferramentas com o histórico
desligado, habilitado e indisponível. A regressão de Core inclui runner,
compactação e migrações: 184 testes passaram na regressão integrada. A conversão
de mensagens passou em 46 testes; o ciclo real de conversa passou em 55, com
14 skips existentes de Windows/projector. O cenário adicional de truncamento real
de skill passou separadamente. Testes adicionais conferem privacidade
na CLI e persistência da correlação no SQLite sem o texto dos resumos.

Os dois testes de ordenação entre shell e chamadas do modelo usam um prazo de
fixture de 30 segundos, ajustado após medições próximas de 10 segundos no Windows.
As asserções de ordenação foram preservadas; esse prazo não mede desempenho do runtime.

A regressão integrada do guidance MCP V2 passou com 272 testes e 1.668 verificações
em 21 arquivos. Inclui cliente HTTP, manager, runner, recibos, reconstrução da
sessão, resultados grandes e auditoria desligada. O corpo codificado Responses
permanece igual com/sem os metadados do recibo. O incremento está somente em fonte;
não altera o instalador Preview 12 nem comprova a transmissão em todos os provedores.
