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
em repetições. O campo `mapping: unmapped-after-conversion` explicita que o
conversor e os adaptadores não preservam a relação com cada parte final. Não há
atribuição por igualdade de texto, inclusive quando vários resumos têm conteúdo
idêntico.

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

Este incremento ainda não cobre os recursos/guidance MCP V2 nem todos os demais
loaders. Não autentica arquivos ou plugins, nem comprova que o adaptador enviou
cada parte observada. Permanece em fonte, fora do instalador Preview 12.

A inspeção aceita até 2 MiB de resultado, 1.024 bytes no identificador de origem
e 4 KiB no recibo projetado. Limites ou ausência do recibo afetam somente a
atribuição; não impedem carregar ou devolver o resultado. Propriedades desconhecidas
não são serializadas e accessors não são executados durante a inspeção.
Resultados de loaders compartilham o limite de 128 fontes e os orçamentos de
metadados/conteúdo dos resumos. O texto do resultado só entra na captura de
conteúdo explícita e é removido do histórico de metadados. Outros loaders e o
backend V2 ainda não recebem esses recibos; a cobertura não é universal.

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
