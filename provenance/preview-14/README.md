# Preview 14 — integração REA

A Preview 14 está ativa em https://cyara.com.br. O update físico 13 → 14 passou, preservando o bootstrap, os dados e a versão anterior. O motor é `1.18.35+cudia.2c8d8027e05e.7800487fc17a`.

REA 6.5.0 foi integrado por MCP sob demanda, com skill e comando `/rea`. Nesta máquina, uma instalação portátil verificada usa o comando MCP padrão, desconectado por padrão. O executável instalado, iniciado por um processo Windows fora do MSIX, conectou, descobriu 207 ferramentas, expôs uma e analisou uma aplicação JavaScript sintética. O alvo não foi executado; os processos da fixture foram encerrados. Nenhum provedor real foi chamado nesse teste.

**Pendente:** a preparação automática pelo alias `cudia:rea` excedeu 240 segundos nesse contexto. A instrumentação localizou a demora na enumeração e no hash dos arquivos, sem estabelecer a causa. A instalação automática do REA em um PC novo ainda não está qualificada. A alternativa local não prova essa capacidade.

A candidata 15 permanece inativa, embora os cinco cenários compilados tenham passado nas duas variantes (581 verificações por variante). O teste posterior no Windows fora do MSIX falhou na mesma preparação. A instrumentação temporária foi removida.

Os instaladores da 14 passaram em duas VMs Windows novas na [tentativa 2 da CI](https://github.com/victorccronemberger-blip/cudia/actions/runs/38972027712/attempts/2). A [CI da candidata 15](https://github.com/victorccronemberger-blip/cudia/actions/runs/38974697505) também passou; isso não substitui o teste local que falhou.

Veja [estado verificável](rea-status.json), [análise pelo MCP padrão](rea-standard-mcp-host.log) e [fases da preparação que falhou](rea-managed-http-phases.log). A configuração global recebeu somente `mcp.rea`, com backup e comparação dos demais valores. Dependências externas como Ghidra/JDK/adb continuam necessárias para as operações correspondentes.

Execução principal com tarefa delimitada em gpt-6-luna/high e consultas de decisão em gpt-6-astra/high. A revisão recomendou manter a candidata inativa e distinguir integração local de preparação automática. O executor corrigiu a chave do perfil de catálogo no script delegado antes de executá-lo.

Um ensaio da alternativa ainda apontava para o alias gerenciado: foi interrompido e seu registro foi preservado. Após corrigir a configuração efetiva da fixture, o teste pelo comando MCP padrão passou (24 verificações). A revisão automática bloqueou o comando que incluía limpar os arquivos temporários anteriores, com a razão “blocked by policy”; esses arquivos foram mantidos. O merge global também foi relido e comparado com o backup: somente `mcp.rea` mudou.
