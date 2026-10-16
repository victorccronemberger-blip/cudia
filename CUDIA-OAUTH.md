# Contas e autenticação do CUDIA

O CUDIA implementa autenticação e transportes dos provedores no próprio runtime.
Isso não adiciona o harness, as ferramentas ou os prompts do Codex/Grok Build.
O texto da conversa e as ferramentas continuam sendo produzidos pelo CUDIA.
Regras, disponibilidade e limites internos do serviço/modelo continuam pertencendo
ao provedor; OAuth não os remove.

## ChatGPT

No pacote que contém esta implementação:

```powershell
cudia providers login --provider openai --method "Continue with ChatGPT"
```

Abra a URL exibida, entre na conta desejada e autorize o CUDIA e o uso do plano.
O cliente usa registro dinâmico próprio, PKCE, estado e nonce por tentativa;
confere a assinatura e a identidade do ID token antes de salvar credenciais.
O primeiro registro retorna o ID emitido para a conta/workspace. Reconexões e
renovações usam esse ID; não reutilizam o identificador de registro inicial.

Cada tentativa escuta somente em `127.0.0.1`, numa porta disponível. Cancelamento,
erro e expiração encerram a tentativa. Uma resposta com estado incorreto não
consome o login válido de outra aba. O navegador e o processo do CUDIA precisam
estar no mesmo computador para o retorno local.

Os novos tokens usam `https://api.openai.com/v1/responses`. O catálogo vem da
conta autenticada em `/v1/models`. Credenciais antigas sem o marcador do novo
fluxo continuam na rota anterior do Codex até o usuário se reconectar. O login
de dispositivo antigo é identificado explicitamente como legado no menu.

O adaptador respeita o formato documentado da prévia: streaming, `store:false`,
histórico enviado no pedido e ferramentas locais em itens `additional_tools`.
Campos que o serviço não aceita são omitidos. Conteúdo de mensagens de sistema
é preservado no papel `developer`; não é acrescentada uma instrução de conduta.
Uma stream sem `response.completed`, ou com falha/incompletude, termina como erro.
Falhas de rede e streams iniciadas não são repetidas silenciosamente.

Para sair:

```powershell
cudia providers logout openai
```

A saída coordena renovação e remoção local e tenta revogar a sessão remota.
Se a revogação falhar, informa que os tokens locais foram removidos e que a
revogação remota não foi confirmada. IDs de registro e do host são preservados
para uma futura reconexão. Uma reconexão concorrente não é apagada pela saída
de uma conta anterior.

## Grok / xAI

O adaptador informa `x-grok-client-version: 1.0.45` apenas na rota OAuth de
primeira parte: essa é a versão de compatibilidade inspecionada no código público
da xAI em 16/10/2026. O User-Agent continua identificando o runtime CUDIA/OpenCode.
O cabeçalho não instala nem executa o Grok Build, e não é enviado a gateways
personalizados ou ao modo API key. Um HTTP 426 é mostrado ao usuário, sem repetição
automática. A xAI pode alterar esse requisito em versões futuras.

```powershell
cudia providers login --provider xai --method "SuperGrok Subscription"
```

Abra a URL e confirme o código exibido no terminal. Esse fluxo usa o cliente
público de dispositivo do Grok Build; a página do provedor apresenta esse nome.
O CUDIA não executa o Grok Build. A assinatura precisa ter acesso aos modelos
e ao serviço de inferência correspondentes.

Pedidos OAuth para os endpoints padrão xAI de Chat Completions/Responses seguem
a rota oficial `https://cli-chat-proxy.grok.com/v1`, com os cabeçalhos de sessão
e do modelo. Esse proxy pertence à xAI. Gateways configurados explicitamente
são preservados. Autenticação por chave continua usando o caminho de API do
provedor, sem esse redirecionamento de OAuth.

Respostas de tokens são validadas e a renovação só é usada após persistência.
Requisições de autenticação têm prazo, polling pode ser cancelado, e um HTTP 401
pode provocar uma única renovação/repetição de corpo reutilizável. Um corpo de
upload em stream e resultados de inferência incertos não são repetidos.
A deduplicação de renovação xAI cobre loaders no mesmo processo; ainda não
certifica coordenação de refresh entre processos distintos.

## Armazenamento e validação

Credenciais ficam no diretório de dados do usuário do runtime, em `auth.json`.
A gravação usa exclusão entre processos, arquivo temporário com modo `0600`
onde suportado e substituição por rename. O registro ChatGPT fica ao lado em
`chatgpt-registration.json`, sem access/refresh tokens. Não copie esses arquivos
para o repositório, logs ou servidor de atualizações.

Testes locais usam servidores próprios, tokens fictícios e assinaturas de teste.
Eles verificam formato, identidade, armazenamento, renovação, rotas e o SDK real;
não comprovam a elegibilidade de uma assinatura. A entrega exige concluir login
e obter uma resposta real nas contas utilizadas. Não há alegação de perfeição
ou de equivalência de inteligência entre modelos.

Em 16/10/2026, login, resposta em streaming e persistência foram confirmados nas
duas contas, primeiro em fonte e depois no executável compilado. A renovação real
dos tokens também foi acionada antecipando o relógio apenas na visão em memória
do ensaio. Os novos tokens foram salvos e usados em processos posteriores. O
ChatGPT respondeu no programa instalado e o Grok respondeu novamente depois da
atualização HTTPS sequência 1 → 2. Isso cobre os modelos ensaiados, não garante
acesso a todo modelo do catálogo nem certifica refresh concorrente entre processos
xAI.

Referências oficiais consultadas em 16/10/2026:

- [Registro e login ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Modelos e inferência ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Contas, renovação e saída](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Limites da prévia](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Autenticação e transporte público do Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md)
- [Rotas de OAuth e API xAI](https://docs.x.ai/build/enterprise)
