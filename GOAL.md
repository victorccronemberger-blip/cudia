# Metas de sessão no CUDIA

Use no chat do CUDIA:

```text
/goal Corrigir os testes do checkout e verificar que passam sem alterar a API pública
/goal
/goal pause
/goal resume
/goal clear
/goal replace <novo objetivo>
```

`/goal` sem argumentos mostra o estado. `status` faz o mesmo. `cancel` conserva
o registro cancelado; `clear` remove apenas a meta da sessão. Outra meta pendente
exige `replace`, inclusive quando está pausada ou bloqueada.

A meta persiste por sessão, fora do histórico que pode ser compactado. O runner
normal executa o trabalho, recarrega mensagens novas nas fronteiras e continua
quando a resposta termina sem concluir a meta. As instruções novas do usuário
têm prioridade. As próximas chamadas seguem o modelo e a variante selecionados
na sessão. Não há planejador nem verificador obrigatório em outra conversa.

Enquanto a meta está ativa, o modelo recebe um lembrete curto no contexto de
mensagens e duas ferramentas: `get_goal`, para ler o estado, e `update_goal`,
para registrar conclusão ou bloqueio com evidência. Nenhuma orientação de meta
é adicionada ao system prompt. O objetivo completo é restaurado no lembrete
quando sua âncora já não está no histórico consumido. Os relatórios e logs não
são copiados para um segundo agente a cada rodada.

Registrar evidência não prova automaticamente sua veracidade: o executor ainda
precisa conferir arquivos, testes, resultados ou outras fontes pertinentes.
Uma declaração de conclusão de uma revisão antiga da meta é rejeitada quando
o usuário a substitui, pausa ou envia novas instruções durante a execução.

Não há limite padrão de 50 rodadas. Se quiser um limite, declare-o:

```text
/goal --token-budget 200000 <objetivo>
/goal --max-iterations 10 <objetivo>
/goal resume --token-budget 100000
/goal resume --max-iterations 5
```

Na retomada, esses valores acrescentam orçamento ao uso já registrado. Sem
valor novo, o orçamento anterior permanece. `--` termina a interpretação de
opções, permitindo um objetivo que contenha literalmente esses nomes.

O consumo soma os tokens informados pelo provedor, incluindo raciocínio e cache,
uma vez por resposta persistida. O limite é conferido entre chamadas; uma
chamada em andamento pode ultrapassá-lo. Não é um teto financeiro nem uma
medição de uso que o provedor deixou de informar. Atingir um limite produz
`budget_limited`, não conclusão ou bloqueio técnico.

Uma continuação automática sem chamada de ferramenta de trabalho suspende novas
continuações e conserva a meta ativa. Consultar apenas `get_goal` não prolonga
o ciclo. Envie uma nova mensagem ou use `resume` para voltar ao trabalho. Uma
interrupção do usuário pausa a meta. Erros do modelo não geram novas tentativas
automáticas ilimitadas pelo Goal.

Fechar o processo não executa trabalho em segundo plano. Ao reabrir a sessão,
use `/goal` para consultar e `/goal resume` para retomar. Registros antigos são
preservados; o antigo limite padrão de 50 deixa de ser aplicado ao migrar pela
retomada. Nenhuma outra sessão é iniciada automaticamente.
