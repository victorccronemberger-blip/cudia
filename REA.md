# REA no CUDIA

Integração sob demanda de [REA — Reverse Engineer Anything](https://github.com/morluto/rea),
usando o pacote oficial `rea-agents@6.5.0`. A revisão examinada de `main` é
`0d224742808e32106e2ee93340c6755ee5e0a0db`, que declara a mesma versão publicada.

## Estado da entrega

A Preview 14 inclui esta integração. Neste PC, o comando MCP padrão com Node e
REA portáteis foi validado no executável instalado. A preparação automática
pelo alias `cudia:rea` excedeu 240 segundos fora do MSIX e ainda não está
qualificada em um PC novo. A candidata 15 permanece inativa.
[Evidências e limitações](provenance/preview-14/README.md).

## Uso

Na conversa do CUDIA, invoque `/rea` com seu objetivo, por exemplo:

```text
/rea analise a estrutura JavaScript deste aplicativo e mostre as evidências
```

A skill `rea` também pode ser carregada pela ferramenta de skills. O servidor
`rea` fica cadastrado e desconectado. Descobrir servidores ou iniciar o CUDIA não
baixa dependências nem inicia o REA. A conexão explícita prepara o runtime; o
primeiro uso precisa de Internet. Reconexões conferem e reutilizam o cache local.

No Windows x64, o comando gerenciado `cudia:rea` prepara Node.js portátil 24.22.0
e REA com versões e integridades fixadas. Não depende de Node, npm ou Git no PATH.
O runtime é privado da integração: não muda o PATH do usuário nem instala software
globalmente. Outros hosts podem configurar o comando oficial de um REA instalado.

O fluxo segue o MCP existente: conectar, buscar os metadados necessários e expor
as ferramentas escolhidas. A skill não conecta por si só e seu corpo não é
acrescentado ao prompt fixo. Não são executados `rea setup` nem alterações nas
configurações de outros agentes. O adaptador não acrescenta filtros por assunto
ou altera as implementações do REA.

## Catálogo e dependências

A medição do servidor real 6.5.0 retornou 207 ferramentas. O catálogo completo
ocupou 3.087.952 bytes, excedendo o orçamento local de 1 MiB do cliente V2.
O modo oficial `REA_MCP_OUTPUT_SCHEMA_PROFILE=off` preservou as mesmas 207
ferramentas em 820.354 bytes. Esse modo omite somente `outputSchema` do catálogo;
REA continua validando os resultados contra seus contratos canônicos. As
descrições e os schemas de entrada permanecem disponíveis para descoberta.

Somente as ferramentas expostas entram no próximo pedido do modelo. Os números
acima medem bytes de JSON do catálogo local, não tokens do prompt. Resultados
continuam sujeitos à paginação e aos artefatos de saída do CUDIA e do REA.

Análise estática de JavaScript/Electron e .NET não requer Ghidra, IDA ou Hopper.
Outras operações têm requisitos próprios: engines, JDK/JADX, adb, navegador ou
ferramentas de captura. A integração não os instala automaticamente. `binary_session`
e os resultados das operações informam a disponibilidade efetiva. Habilitar o MCP
não comprova que todas essas capacidades funcionam neste computador.

## Integridade e origem

- REA: pacote `rea-agents@6.5.0`, com dependências fixadas em
  `packages/core/src/mcp/rea-deps/bun.lock`; scripts de instalação não são executados.
- Lock SHA-256: `dd0163078350dbcaf412baaa9c519bdc706e8ef556db9a7da9f6a8eef63d8685`.
- Node: `https://nodejs.org/dist/v24.22.0/win-x64/node.exe`.
- Node SHA-256: `ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c`.

O cache conserva recibos e inventário dos arquivos instalados. Preparação usa um
lock por identidade e publica o recibo ao final; interrupção não publica uma
instalação incompleta como pronta. Versões do REA mudam por atualização explícita
dos dados fixados do CUDIA, sem resolver `latest` a cada abertura.

REA é distribuído sob MIT, com licenças próprias para suas dependências. A
integração usa o pacote original, preservando seus arquivos de licença.
Ferramentas externas conservam seus requisitos e licenças. Documentação oficial:
[instalação](https://github.com/morluto/rea/blob/0d224742808e32106e2ee93340c6755ee5e0a0db/docs/installation.md),
[contratos MCP](https://github.com/morluto/rea/blob/0d224742808e32106e2ee93340c6755ee5e0a0db/docs/mcp-contracts.md).
