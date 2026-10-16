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

## Validação

Os testes cobrem exclusão de texto e campos desconhecidos, retenção por bytes e
quantidade, paginação, arquivos incompatíveis, falha de transação, contenção,
dois processos concorrentes e encerramento antes do commit. A integração usa um
provedor HTTP local e compara exatamente mensagens e ferramentas com o histórico
desligado, habilitado e indisponível. A regressão de Core inclui runner,
compactação e migrações: 175 testes passaram.
