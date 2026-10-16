# Candidato do motor — orçamento de namespaces MCP

Este é um candidato local do motor Windows x64, normal e baseline. Não é uma
nova release ou um instalador; a Preview pública e instalada continua na sequência 10.

- Fonte compilada: `2daad05e1bb326acf30b117f22a1c6e399e55794`.
- Versão: `1.18.35+cudia.2daad05e1bb3.7af12daab3dc`.
- Fingerprint: `7af12daab3dc34179be0df24ad2e7982cb2c0529`.
- Ambos os executáveis: 138.416.640 bytes; SHA-256
  `c134851dac48911dbf006db9ae459b4b5fc328366ca6a700ebe920c40d1ef545`.

[qualification.json](qualification.json) vincula os recibos e inventários
observados aos executáveis e aos hashes dos logs locais. Os artefatos permanecem
em `packages/opencode/dist-mcp-budget-7af12daab3dc`, fora do versionamento;
`engine-build.json` e `engine-inputs.json` ficam na pasta de cada variante.
Este relatório não disponibiliza os binários ou inventários completos para download.
Os builds não são declarados herméticos, reproduzíveis ou recompilados independentemente.

O novo cenário captura os pedidos HTTP reais a um provedor local determinístico:
128 servidores MCP remotos locais iniciam somente após solicitação explícita;
o pedido seguinte tem 3.032 bytes na descrição de `execute`, sem orientação remota
no sistema, e a última ferramenta é descoberta e executada em quatro turnos.
O mesmo teste falha na Preview 10 pela ausência do resumo compacto, servindo de
controle negativo. Isso verifica transporte e contexto, sem medir inteligência
de um modelo ou estabelecer um teto universal de tokens.

Sete cenários compilados cobrem esse fluxo, MCP V1 nos dois modos, MCP V2,
compactação manual, paginação de resultados após compactação/reinício, instruções
ambientais por opt-in e origem do contexto após atualização/remoção/reinício.
A baseline passou nos sete, com 989 verificações em 82,78 segundos.
A normal teve seis aprovações e um timeout na fixture de prontidão; o teste
afetado passou depois, com 54 verificações em 15,27 segundos. Não se trata de uma
rodada normal unificada com sete aprovações. A causa precisa da espera inicial
não foi demonstrada; a consulta de prontidão agora tem prazo de dois segundos
por tentativa, mantendo o prazo externo de 30 segundos. Essa alteração de teste
ocorreu após o build e está registrada separadamente do recibo congelado do motor.

Validação de instalador, Windows novo, assinatura, atualização HTTPS e OAuth não
foi repetida neste candidato. A promoção depende dos gates de distribuição.
