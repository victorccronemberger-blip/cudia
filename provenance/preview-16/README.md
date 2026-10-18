# Preview 16 — falhas de provedores isoladas

Corrige a queda de abertura observada na Preview 14 quando a renovação do ChatGPT retornava HTTP 400. O erro atravessava a descoberta de modelos e fazia `/config/providers` e `/provider` retornarem 500.

Cada provedor recebe uma fronteira para falhas de descoberta, autenticação e loaders. Uma falha retira apenas aquele provedor da lista conectada, preservando o catálogo para reconexão e as credenciais salvas. Loaders posteriores não o reativam. Resultados são aplicados depois do sucesso, e erros de seleção do modelo informam o provedor indisponível sem expor respostas privadas de autenticação. Não há troca automática de modelo ou de credenciais.

O motor instalado é `1.18.35+cudia.d432cbe1bbbb.00c710065e74`, com fonte `d432cbe1bbbb976a69e0e203f29ae866938ce72a` e SHA256 `4fcbea35f58a9a884a4ebf927c5d14751265366178773e961473e5ad5aa19f0f`. A atualização local assinada 14 → 16 preservou o bootstrap e o motor anterior. A desativação temporária de OpenAI foi retirada, com backup da configuração.

Na instalação física, iniciada por Explorer fora do MSIX, as sete rotas usadas na conferência de abertura retornaram 200 com OpenAI habilitado e a credencial expirada preservada. A seleção do modelo OpenAI retornou 400 e uma mensagem atribuível. Em seguida, outra sessão na mesma instância recebeu uma resposta de um provedor sintético local. Não foi feita inferência real em QwenCloud ou xAI para esta verificação.

Validação: 114 testes de provedores/281 verificações, 9 de isolamento/44, 7 de formatação/20 e 6 do middleware HTTP/20; nenhuma falha. O typecheck de opencode passou. Os instaladores normal/baseline passaram em [Windows limpo na CI](https://github.com/victorccronemberger-blip/cudia/actions/runs/39161385887). As transições assinadas 14 → 16 das duas variantes também passaram. A cobertura está registrada em [delivery.json](delivery.json).

Há prazo de 10 segundos por etapa. Etapas sequenciais podem acumular esse tempo. Plugins sem suporte a abort podem continuar seu trabalho até o prazo interno; seus resultados tardios não são aplicados ao registro. O teste de cancelamento demonstra retorno de controle por timeout externo, sem afirmar interrupção direta de todo plugin. A preparação automática do REA fora do MSIX permanece pendente; a candidata 15 não foi ativada.

Tentativas anteriores foram preservadas: dois testes gerais detectaram a perda de mutações intencionais no catálogo de um loader; a correção foi seguida pela rodada completa de 114 casos. Um build foi descartado por mudança de teste durante a geração. Um candidato intermediário ainda mostrava erro genérico ao selecionar o modelo; a tradução HTTP foi corrigida antes dos artefatos finais. Uma primeira tentativa de instalar recebeu o estado redirecionado pelo MSIX e recusou a operação antes de gravar; a instalação física foi realizada pelo Explorer. A primeira publicação foi executada fora da pasta Git e falhou antes da ativação; a repetição na pasta correta concluiu a publicação.

Execução principal; testes delimitados em gpt-6-luna/high e revisões de decisão em gpt-6-astra/high, pelo codex-advisor. A revisão exigiu testar a conta expirada habilitada e repetir a suíte completa depois da correção do loader; ambas as condições foram verificadas.
