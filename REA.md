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
Outras operações têm requisitos próprios. A preparação opcional abaixo foi adicionada
ao código e está em qualificação; ainda não está publicada no instalador Preview 16.
`binary_session` e os resultados das operações informam a disponibilidade efetiva.
Habilitar o MCP não comprova que todas essas capacidades funcionam neste computador.

## Ferramentas opcionais no Windows x64

```text
cudia rea install wabt
cudia rea install jadx apktool adb
cudia rea status
```

O primeiro comando prepara WebAssembly. O segundo prepara as ferramentas Android
e um JDK completo, sem depender de Java no PATH de um PC novo. Sem nomes,
`cudia rea install` prepara somente WABT. `status --json` retorna o inventário local.

| Pacote | Versão fixada | Seleção fornecida ao processo REA |
| --- | --- | --- |
| WABT | 1.0.42 | `REA_WABT_BIN_DIRECTORY`, incluindo `wasm-validate`, `wasm-objdump`, `wasm2wat` |
| JADX headless MCP | 0.7.1 | `REA_JADX_MCP_JAR` (o JAR de engine aceito pelo REA, diferente do JADX comum) |
| Eclipse Temurin JDK | 21.0.12.1+1 | `JAVA_HOME`, com `java` e `javac` |
| Android Platform Tools | 37.0.1 | `REA_ADB_PATH` |
| Apktool | 3.0.3 | `REA_APKTOOL_COMMAND`, com launcher que usa o Java selecionado |

Instalações ficam no cache privado do CUDIA. O download usa URL, tamanho e SHA-256
fixados; arquivos instalados são inventariados e conferidos nas próximas conexões.
A publicação da instalação é atômica e preparações simultâneas compartilham um lock.
O download interrompido pode ser repetido; os pacotes já concluídos são reutilizados.

A descoberta acontece ao conectar um REA reconhecido, tanto pelo alias gerenciado
quanto pelo comando Node do pacote oficial. Ela não baixa nem repara pacotes.
Valores explícitos do operador têm precedência. Pacote opcional ausente ou
corrompido não impede o servidor REA de abrir nem desabilita os outros pacotes.
Reconecte o REA após instalar ferramentas para receber o novo ambiente.
Não há alteração no PATH global nem inclusão de catálogos no prompt fixo.

Ghidra e ILSpy ainda exigem instalações próprias. IDA, Hopper e JEB conservam seus
requisitos de licença e configuração. Binwalk/Unblob e outras integrações Linux
não são apresentadas como ferramentas nativas disponíveis no Windows.

Origens: [WABT](https://github.com/WebAssembly/wabt/releases/tag/1.0.42),
[JADX headless](https://github.com/1013503897/jadx-headless-mcp/releases/tag/v0.7.1),
[Temurin](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12.1%2B1),
[Apktool](https://github.com/iBotPeaches/Apktool/releases/tag/v3.0.3),
[Platform Tools](https://developer.android.com/tools/releases/platform-tools).
O SHA-256 de Platform Tools foi calculado sobre o ZIP oficial, após conferir seu
tamanho e SHA-1 contra `repository2-3.xml` do Google; não é um SHA-256 publicado pelo Google.

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
