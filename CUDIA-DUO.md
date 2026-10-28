# Duo: dois modelos no mesmo objetivo

`/duo` inicia uma execução colaborativa explícita dentro da conversa atual. Os
dois participantes recebem o mesmo objetivo e trabalham em sessões-filhas
separadas, cada uma com seu próprio modelo. Os dois começam em paralelo, inclusive
fora de um repositório Git. O histórico da conversa
principal e os históricos das sessões-filhas permanecem separados; a execução
não transforma cada turno normal em uma chamada a dois modelos nem altera o
comportamento padrão dos provedores.

## Comandos

- `/duo <objetivo>` inicia uma execução para este objetivo.
- `/duo status` mostra o estado, o ID da execução, os IDs das sessões-filhas,
  seus modelos e diretórios, e o estado do trabalho e da revisão de cada uma.
  `/duo` sem argumentos também mostra esse estado.
- `/duo resume` retoma explicitamente uma execução interrompida ou incompleta,
  preservando sessões, resultados e diretórios existentes.
- `/duo continue <orientação>` inicia uma nova rodada para o objetivo salvo,
  acrescentando a orientação e pedindo novamente trabalho aos dois participantes.
- `/duo cancel` interrompe uma execução ativa. As sessões, resultados e
  diretórios são preservados para inspeção e eventual retomada.

Palavras reservadas podem ser usadas como objetivo literal com `--`; por
exemplo, `/duo -- status` inicia o objetivo `status`.

## Participantes e configuração

As opções são lidas quando `/duo` é chamado, em
`~/.config/opencode/duo.json` (no Windows, normalmente
`%USERPROFILE%\.config\opencode\duo.json`). Sem esse arquivo, os padrões são
Drael (`drael/drael-v1`, variante `high`) e GPT
(`openai/gpt-6-luna`, variante `high`). A configuração exige exatamente dois
participantes:

```json
{
  "participants": [
    { "name": "Drael", "model": "drael/drael-v1", "variant": "high" },
    { "name": "GPT", "model": "openai/gpt-6-luna", "variant": "high" }
  ],
  "review": true,
  "peerChars": 12000
}
```

`review` é opcional e vem ativado por padrão. Com a revisão ativada, cada
participante revisa o resultado do outro uma vez. `peerChars` limita a
quantidade de caracteres do resultado do par incluída em cada revisão e tem
padrão de 12.000. Modelos, variantes e agentes podem ser ajustados por
participante.

## Execução e diretórios

Cada participante recebe o objetivo compartilhado e pode trabalhar em sua
própria sessão-filho. A cada turno concluído, compartilha um resumo curto de texto
público e resultados de ferramentas. O outro recebe a atualização antes da sua
próxima chamada ao modelo, mesmo enquanto ainda está trabalhando. Raciocínio
interno e históricos completos não são copiados entre as sessões. Cada chamada
recebe somente a atualização mais recente, com até 4.000 caracteres de conteúdo
(ou o limite menor definido em `peerChars`), sem acumular cópias de atualizações
antigas no histórico.
Os IDs das sessões-filhas ficam visíveis em `/duo status`, e retomadas reutilizam
essas sessões.

Em um repositório Git com `HEAD`, o Duo cria duas worktrees destacadas e copia
para ambas o mesmo commit, as alterações rastreadas e os arquivos não ignorados
que ainda não estão rastreados. Arquivos ignorados, como dependências locais, não
são copiados, e o Duo não instala dependências nem executa scripts de preparação.
As worktrees permanecem no disco depois da execução ou do cancelamento.

Sem Git, sem um commit inicial ou quando a preparação excede 64 MiB, o Duo
continua em paralelo na pasta compartilhada e informa essa condição no
resultado. Nesse modo, as alterações feitas por um participante ficam visíveis
para o outro. As operações estruturadas `write`, `edit` e `apply_patch` coordenam
acesso concorrente aos mesmos arquivos dentro do processo; comandos de shell e
editores externos conservam seu próprio comportamento. Com Git, as worktrees
permanecem separadas da pasta original. Quando o objetivo pede alterações, o primeiro participante (Drael por
padrão) coordena a resposta e integra na pasta original as mudanças solicitadas,
usando os resultados e artefatos dos participantes como evidência.

Assim que termina seu próprio trabalho, cada participante pode revisar o que o
par já produziu, incluindo progresso parcial. Essa revisão também é compartilhada
com o par que ainda está trabalhando, sem esperar ambos encerrarem o trabalho. O
primeiro participante, Drael por padrão, coordena a resposta e integra o
trabalho pedido na pasta original. Se a tarefa ou o transporte do coordenador
falhar e o trabalho do outro participante tiver sido concluído, esse participante
pode assumir a integração. Uma resposta de recusa concluída é um resultado, não
uma falha de transporte ou de tarefa, e não dispara essa substituição.

## Retomada e custo

O estado da rodada é salvo por conversa. `/duo resume` é explícito para que uma
execução interrompida não volte a chamar modelos inesperadamente. Uma retomada
de trabalho incompleto pode repetir uma solicitação que já chegou ao provedor
antes da interrupção; não há garantia de execução exatamente uma vez.

Uma rodada pode fazer duas chamadas lógicas de trabalho, até duas de revisão e
chamadas adicionais do coordenador para integrar os resultados. Cada chamada
lógica pode envolver vários turnos do modelo e ferramentas, conforme a tarefa.
O número de chamadas e o custo dependem do provedor, da duração do trabalho e
das revisões habilitadas.
