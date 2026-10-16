# MCP sob demanda — incremento dos fontes

Esta alteração parte do commit público 0ef7fed4dcd039b95818502011331c663ab82642.
A Preview 9 publicada e instalada permanece inalterada. Este documento não anuncia
um instalador novo: compilar e qualificar a distribuição são etapas posteriores.

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

## Validação

89 testes passaram em seis suites, com 342 verificações: ciclo de vida MCP, catálogo,
CodeMode, prompt de sistema, composição de contexto e captura HTTP real dos pedidos
V1, com e sem CodeMode. A captura confirmou zero inicializações antes da conexão
explícita, uso de ferramenta, consulta de instruções e remoção após desconectar.
Typechecks de opencode e tui passaram. A revisão independente não apontou bloqueador
para registrar os fontes; não substitui a qualificação de uma distribuição compilada.

A regressão também revelou uma falha no fechamento de clientes durante cancelamento:
o tratamento anterior podia ser interrompido antes da limpeza. Um finalizador agora
encerra o cliente mesmo quando a descoberta de ferramentas é cancelada.
