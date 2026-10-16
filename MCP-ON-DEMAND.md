# MCP sob demanda — Preview 11

Esta alteração parte do commit público 0ef7fed4dcd039b95818502011331c663ab82642.
O motor da Preview 11 foi compilado do commit
`2daad05e1bb326acf30b117f22a1c6e399e55794` e está disponível em https://cyara.com.br.
Os instaladores normal/baseline passaram em VMs Windows novas; a instalação desta
máquina atualizou por HTTPS de 10 para 11 e respondeu via Grok na conta existente.
[Recibos e evidências](provenance/preview-11/README.md) distinguem a revisão
compilada das alterações posteriores na documentação e no publicador.

## Comportamento

- Ler a configuração, o status ou o catálogo não inicia transportes MCP, login,
  descoberta de ferramentas nem preparação do navegador gerenciado.
- A conexão é explícita. No CodeMode usam-se os helpers tools.$mcp existentes.
  Sem CodeMode, a ferramenta mcp oferece servers, connect, disconnect e instructions.
  A busca de servidores é paginada e contém nomes e estado, sem credenciais.
- Após conectar, as ferramentas ficam disponíveis no próximo pedido. Desconectar
  remove as definições do pedido seguinte. A API de adicionar e conectar permanece.
- Instruções remotas são consultadas explicitamente como resultado de ferramenta;
  não são incorporadas automaticamente ao prompt de sistema.
- Conexões simultâneas ao mesmo servidor compartilham uma tentativa. Cancelar o
  iniciador cancela essa tentativa e informa falha aos participantes. Cancelar um
  participante que aguarda não cancela o iniciador. Uma nova chamada pode tentar novamente.
- Fechar a instância cancela conexões pendentes e encerra processos stdio próprios.
  A validação de encerramento usa o PID real do processo. Não afirma destruição de
  sessões remotas HTTP no servidor.

Nenhum filtro por assunto ou nova etapa de autorização foi introduzido. O comportamento
interno do provedor permanece sob controle do provedor.

## Validação original — Preview 10

89 testes passaram em seis suites, com 342 verificações: ciclo de vida MCP, catálogo,
CodeMode, prompt de sistema, composição de contexto e captura HTTP real dos pedidos
V1, com e sem CodeMode. A captura confirmou zero inicializações antes da conexão
explícita, uso de ferramenta, consulta de instruções e remoção após desconectar.
Typechecks de opencode e tui passaram, além das 30 tarefas do repositório.
Os 19 cenários compilados foram cobertos em cada variante. No primeiro ensaio normal,
um cenário excedeu o prazo padrão de cinco segundos e dois aguardavam ZIP/LSP;
a repetição focada passou com esses inputs e prazo de 120 segundos. O ensaio baseline
passou nos 19 cenários, sem skips. Os dois instaladores passaram nas VMs novas,
com PATH mínimo, CMD em outra pasta, catálogo frio e remoção.
A revisão independente foi concluída antes da ativação do canal.

A regressão também revelou uma falha no fechamento de clientes durante cancelamento:
o tratamento anterior podia ser interrompido antes da limpeza. Um finalizador agora
encerra o cliente mesmo quando a descoberta de ferramentas é cancelada.

## Preview 11 — muitos servidores

A Preview 11, instalada e publicada, limita em 3.200 bytes UTF-8 o conjunto
de cabeçalhos de namespaces do CodeMode,
incluindo separadores de linha. Quando excedido, todos os cabeçalhos dão lugar a
uma contagem e orientação de descoberta. Não se escolhe um subconjunto alfabético.
Assinaturas selecionadas, índice de busca e ferramentas executáveis permanecem.
O orçamento de assinaturas continua separado; isso limita o custo dos cabeçalhos,
sem declarar um teto absoluto de tokens ou de toda a descrição.

Uma fixture com 1.000 namespaces e nomes ASCII de 80 caracteres adicionais,
com orçamento de assinaturas zero, passou de 117.428 para 2.680 bytes de descrição.
Com 100 namespaces, ficou em 2.678 bytes. São bytes observados, não tokens medidos.
Os testes cobrem o limiar exato, um byte excedente, nomes multibyte e enormes,
catálogo vazio, assinaturas parciais/completas, descoberta paginada dos 1.000 itens,
busca exata e execução do último namespace. A integração V1 também executa a
ferramenta do último de 1.000 servidores MCP com nomes sanitizados.

Validação: 266 testes do pacote CodeMode e 42 da integração V1 passaram, com
1.069 verificações no total; os typechecks de CodeMode e Opencode passaram.
O executor principal implementou a correção; gpt-6-astra/high revisou a decisão
e os resultados pela skill codex-advisor, sem apontar pendência material.

O incremento foi compilado em normal/baseline a partir de
`2daad05e1bb326acf30b117f22a1c6e399e55794`. Um novo teste HTTP confirmou 128
conexões explícitas e 3.032 bytes na descrição real de `execute`, sem orientação
remota no sistema, com busca e chamada da última ferramenta em quatro turnos.
O teste falha na Preview 10 anterior pela ausência do resumo compacto.
Sete cenários compilados foram cobertos por variante; a normal precisou de uma
repetição focada após corrigir o timeout da consulta de prontidão da fixture.
Recibos, hashes, resultados e limites estão em
[provenance/mcp-budget-candidate](provenance/mcp-budget-candidate/README.md).
Esse candidato foi promovido à Preview 11. Os 20 cenários completos passaram
por variante, com 1.597 verificações cada, usando o ZIP correspondente e LSP real.
Os dois instaladores passaram em VMs Windows Server 2025 novas. A atualização
física por HTTPS de 10 para 11, CMD, hash/caminho físico, retenção da versão anterior,
consulta de versão atual e resposta Grok foram conferidos.
[Evidências da publicação](provenance/preview-11/README.md). A rodada inicial de
sete cenários acima é histórica e não substitui a qualificação completa posterior.
