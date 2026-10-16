# Release Windows do CUDIA

Este procedimento descreve a cadeia implementada e os gates ainda necessários.
Uma compilação local, um manifest assinado e uma publicação pública são resultados
distintos. `validatedForPublication` permanece falso no builder; nenhum desses
arquivos deve ser promovido a produção apenas por existir.

## Preview ativa

O manifest Preview ativo é a sequência 13, com motor
`1.18.35+cudia.832e3f3741f0.85c5350f484c`. A release pública contém dois
instaladores Inno Setup e dois arquivos de atualização. O publicador verificou
os quatro downloads antes de ativar o manifest em `cyara.com.br`. Os mesmos
instaladores passaram por instalação, PATH, abertura fria e remoção em duas VMs
Windows Server 2025 novas. A máquina de trabalho atualizou de 12 para 13 por HTTPS,
verificou caminho físico e hash do motor, CMD em outra pasta, versão anterior
preservada, resposta Grok e consulta sem update pendente.
O motor foi compilado do commit `832e3f3741f03c62de06962e2595726f6b63c13f`;
o cliente 12 foi preservado byte a byte. A entrega distribui histórico opcional de
metadados, recibos dos loaders selecionados e imagens no adaptador nativo.
Normal passou os 21 cenários/1.717 verificações numa rodada; baseline tem cobertura
segmentada dos mesmos cenários, com dois timeouts intermitentes preservados e
causa não estabelecida. Não houve mudança de prazos ou assertions. O teste novo
de contexto/imagens passou com 27 verificações por variante.
[Evidências](../../provenance/preview-13/README.md).

O manifest e o manifest incorporado nos instaladores expiram em **15/11/2026**.
As candidatas 7 e 8 foram retiradas antes da ativação; seus assets são preservados
e suas sequências não podem ser reutilizadas. O motor padrão usa catálogo
incluído e não depende dos serviços hospedados pelo OpenCode. A chave privada
fica local; o serviço e a CI recebem apenas a confiança pública.

O registro detalhado da sequência 3 abaixo é histórico e não descreve o manifest
ativo. Os limites Preview continuam valendo: os ensaios em VMs Server novas não
substituem a validação interativa como usuário comum em Windows 10/11, e um
certificado Authenticode de editor ainda não está configurado.

Histórico da primeira distribuição:

O motor `1.18.35+cudia.a1c9471a1874.9c3e01c957f2` foi distribuído nas variantes
normal/baseline, com recibos e inventários observados. A release pública é
`cudia-preview-20261016-9c3e01c957f2`; seus seis assets foram baixados e conferidos
por tamanho e SHA256 antes da publicação do manifest. A branch de serviço é
`codex/update-service`, com Node 22, raiz `deploy/updates` e entrada `server.js`.
O carregador da Hostinger importa essa entrada: ela deve chamar `listen()` mesmo
sem ser o módulo principal. A fábrica HTTP isolada está em `app.js`.

A instalação Preview real passou neste Windows, com registro por usuário e uma
entrada no PATH. O CMD iniciou o motor em outra pasta com PATH mínimo, sem Git
ou Bun. O cliente verificou o manifest HTTPS, baixou e ativou a sequência 2 a
partir da sequência 1, preservou a versão anterior e iniciou uma nova inferência
Grok com sucesso. Uma segunda consulta informou que já está atualizado. Essa
transição manteve os bytes do motor e avançou a identidade assinada do bundle;
não simula uma alteração de código do motor. `/ready` aguarda o canal stable;
o endpoint Preview é `/updates/v1/preview.json`.

Os arquivos de custódia, ledger e artefatos estão fora do checkout/OneDrive,
sob `%LOCALAPPDATA%\CudiaReleaseAuthority` e `%LOCALAPPDATA%\CudiaReleases`.
A chave `cudia-release-20261016` tem uma segunda cópia local conferida; ambas
continuam expostas à falha da mesma máquina. Não foi feito backup externo.
O keyring não restringe criptograficamente essa chave ao canal Preview.

O manifest histórico dessa distribuição expirava em **14/01/2027**; a validade
da sequência ativa está indicada acima. Antes de expirar, emita metadata nova com sequência
crescente e reconstrua/revalide os instaladores; o setup arquivado também exige
um manifest válido. Permanecem pendentes a certificação em Windows limpo e um
certificado Authenticode de editor. O resultado é uma Preview funcional, não
qualificação geral de produção ou conclusão de todos os gates abaixo.

## Identidade dos artefatos

1. Construa o motor com `--provenance`, versão e snapshot de modelos definidos.
   Preserve `engine-build.json` e seu inventário irmão `engine-inputs.json` com o
   executável. Registre fingerprint e evidência dos testes. Não produza um recibo
   novo para um executável antigo cuja compilação não foi observada.
2. Construa o cliente com `build-client.ps1 -PublicKeysPath ...` em uma saída nova.
   Preserve `client-build.json` com os dois executáveis. Confira `trust-info`.
3. Use `package.ps1 -ClientBuildInfoPath ... -EngineBuildInfoPath ... -RequireEngineProvenance` com o launcher correspondente, versão,
   canal e sequência reservados para a release. O descritor vincula os hashes de
   motor, launcher, defaults e registros de build ao ZIP.
4. Assine o payload com `deploy/updates/publish.js`. A chave privada fica fora do
   checkout, do pacote, dos logs, de variáveis remotas e da Hostinger. O publicador
   recebe o caminho local por `CUDIA_RELEASE_PRIVATE_KEY_FILE`.
5. Passe os mesmos bootstrap, launcher, ZIP e manifest a `build-installer.ps1`.
   Confira `completed`, identidade, hashes, confiança e validade em `build-info.json`.
   O builder rejeita vínculos incoerentes mesmo quando o ZIP tem assinatura válida.

Os registros descrevem os bytes observados e as fontes copiadas. A assinatura
vincula o registro à release; ela não transforma uma declaração sobre fontes em
prova independente da execução do compilador. O registro do cliente não inventaria
toda a instalação Go ou todo o ambiente herdado. Um motor com recibo correspondente
usa `observed-build`, com escopo e omissões explícitos. O build mede fontes Git,
inputs do bundler, arquivos gerados, entradas conhecidas do plugin, Bun e resultado;
não inventaria integralmente leituras transitivas do plugin, resolução ou runtime
de destino administrado pelo Bun. Sem recibo a origem permanece `not-recorded`.
O empacotador não compila o motor nem deduz sua origem pelo checkout atual.

## Custódia e sequência

Antes de criar uma chave de publicação, defina seu responsável, autoridade
pretendida, localização protegida fora do checkout/OneDrive, backup e recuperação.
Crie arquivos exclusivamente, confira a ACL e nunca gere uma chave substituta
automaticamente durante um build. Testes usam chaves descartáveis próprias.

O formato atual do keyring mapeia IDs para chaves públicas, sem autorização por
canal dentro de cada chave. O payload e o endpoint verificam o canal. Não declare
que um keyring compartilhado torna uma chave exclusiva de preview. O conjunto
incorporado no cliente e o conjunto do serviço precisam refletir a autoridade
de release escolhida antes de publicar qualquer assinatura.

Mantenha um ledger durável de versões, canais, sequências, artefatos e resultados
dos gates. Reserve sequências crescentes antes de assinar; não reutilize uma
sequência publicada com outro conteúdo. Esse ledger ainda não é automatizado.
Para distribuir novamente um motor anterior, publique uma nova release com
sequência maior e registre qual artefato anterior foi selecionado.

## Publicador local

`release.mjs` publica arquivos já construídos e qualificados; não compila o motor,
o cliente ou o instalador e não transforma recibos de build em aprovação de QA.
O comando `stage` é uma etapa local para preparação de CI: aceita uma qualificação
ausente ou pendente, confere ledger, recibos e vínculo do instalador, e cria ou
retoma somente uma release Draft. Não lê o conteúdo da chave privada, não assina,
não publica a release e não ativa o serviço. Ele não prova que a build do CI é
reprodutível nem conclui a qualificação Windows.
Prepare um plano JSON novo com a revisão de origem, tag, commit esperado da branch
de serviço e datas de validade atuais. Use caminhos absolutos para os dois ZIPs normal/baseline,
seus recibos `package.ps1`, os instaladores compilados e seus `build-info.json`,
um arquivo de qualificação com hashes dos mesmos artefatos e todos os gates
aprovados, as notas e os arquivos locais de chave pública/privada. Use
`release-plan.example.json` como formato inicial. A chave privada deve ficar fora
do checkout; o comando nunca cria uma chave nem altera variáveis globais.

O ledger durável é um objeto `{ "schema": 1, "releases": [...] }`. Antes da
publicação, outra etapa deve reservar uma entrada `{ "channel", "sequence",
"version", "state": "reserved", "reservedAt", "keyId", ... }`. O publicador
exige essa entrada e sequência crescente, confere os hashes contra os recibos e a
qualificação, e atualiza somente a entrada escolhida depois que o manifest ativo
for confirmado por HTTPS. Campos históricos permanecem intactos. A sequência
publicada não pode ser reutilizada com outros bytes.

Rode o preflight local e revise os quatro hashes antes de preparar a Draft:

```powershell
node installer/windows/release.mjs preflight --plan C:\release\sequence-7\plan.json
node installer/windows/release.mjs stage --plan C:\release\sequence-7\plan.json
```

`stage` retorna o ID da Draft e os nomes, IDs, tamanhos e hashes verificados dos
assets. A qualification pode continuar `pending` enquanto uma VM Windows nova
executa os gates. A Draft não é uma release pública; não a compartilhe como
qualificada. Um arquivo já publicado nunca recebe uploads: se faltar um asset,
o comando para sem substituí-lo.

O token `contents: read` da CI não deve ser tratado como acesso a uma Draft.
Na sequência 10, os dois jobs receberam HTTP 403 antes da instalação. Os mesmos
assets foram então publicados como pré-release explicitamente identificada como
**candidata em validação**, sem marcar como latest e sem alterar o canal assinado.
O download anônimo respondeu 200 e a repetição dos jobs passou. Esse é um estado
público não qualificado: usuários podem baixar a candidata, e o título/notas devem
informar isso. Depois da aprovação, as notas locais e da release precisam coincidir
com o plano antes de `publish`. Uma candidata reprovada deve ser registrada como
retirada, preservando os assets e sua sequência. A [documentação do GitHub](https://docs.github.com/en/rest/releases/releases#list-releases)
distingue a visibilidade pública das releases e o acesso de escrita às Drafts.
Esse fluxo não exige ampliar a credencial da CI nem enviar a chave de assinatura.

Depois que o arquivo de qualificação listar os mesmos artefatos e todos os gates
aprovados, a fase explícita `publish` usa a credencial GitHub disponível
no helper de credenciais Git, envia os ativos sem substituir nomes existentes,
baixa e compara cada upload autenticado, publica a release e verifica os URLs
HTTPS públicos. Depois, ativa o manifest já assinado localmente na branch de
serviço indicada, baseada no commit esperado. A assinatura e a confiança local
são conferidas antes de criar a release. A branch de serviço é atualizada
com um commit criado por plumbing Git; o checkout e o índice do operador não são
usados. O publicador confere a chave pública presente nesse commit antes de criar
a release e verifica o manifest exato no endpoint HTTPS depois da ativação.
O push da branch de serviço dispõe de até dez minutos porque pode executar o
hook de validação do repositório. Os demais comandos conservam seus prazos próprios.
Um timeout não prova que o push falhou: confira a referência remota e o manifest
exato antes de repetir. O encerramento do processo Git não garante o encerramento
de todos os descendentes de um hook; identifique somente os processos daquela
operação antes de qualquer limpeza.

```powershell
node installer/windows/release.mjs publish --plan C:\release\sequence-7\plan.json
```

Um journal ao lado do caminho indicado registra as fases. O publicador mantém um
lock para o ledger inteiro e outro para o journal; isso impede atualizações
concorrentes perdidas entre canais ou para a mesma release. Repetir a publicação
confere os ativos já existentes byte a byte e continua sem substituí-los. Se uma
execução for encerrada à força, locks ficam no disco para impedir outra escrita;
remova-os manualmente só depois de confirmar que o processo não está mais ativo e
de conferir o journal. Falhas depois da publicação dos downloads deixam o manifest
anterior ativo. Após o commit da branch, o publicador consulta o endpoint por até
dois minutos, aceitando apenas os bytes exatos do manifest assinado. A ativação do
manifest é sempre a última mutação pública.

## Rollover de chaves no ABI 1

O bootstrap fixo verifica os bytes do launcher selecionado pelo estado da
instalação e o inicia. O launcher daquela versão verifica updates com seu próprio
keyring incorporado. Portanto uma atualização autenticada pode trocar o keyring
sem trocar o bootstrap:

1. Clientes atuais confiam em A. Publique uma versão de transição que confia em
   A+B, assinando seu manifest com A.
2. Após validar a distribuição dessa transição, publique a próxima versão assinada
   com B. Seu launcher pode conservar A+B durante a janela operacional escolhida.
3. Publique uma versão assinada com B cujo launcher confia apenas em B. Nessa
   versão ativa, manifests assinados somente por A são rejeitados.

O teste `trust-rotation.test.mjs` exercita A → A+B → B com executáveis reais,
assinaturas locais e um bootstrap A que permanece byte a byte igual. Confere
também rejeição de B antes da transição, rejeição de A depois dela, preservação de
ativação em falhas, sequência e versões anteriores. Isso prova a instalação local
de bundles; não é um teste de entrega HTTPS ou da Hostinger.

Essa retirada de A vale para o launcher ativo. Versões anteriores continuam
armazenadas, e um rollback explícito pode selecionar um launcher com confiança
anterior. Não se trata de revogação global permanente de todas as versões locais.
Pular a versão de transição pode deixar um cliente antigo sem reconhecer B;
planeje a distribuição e a recuperação desses clientes antes de retirar A.

Alterar o próprio bootstrap ou seu ABI é outra operação. A manutenção de um
bootstrap incompatível ainda precisa de implementação e validação preservando
configurações, sessões, versões e o maior número de sequência observado. O wizard
atual não declara essa migração concluída. Não há coleta automática das versões
antigas; os limites do inventário também precisam entrar na manutenção.

## Validade do instalador e dos updates

O mesmo manifest autenticado é embutido no instalador e consultado pelo atualizador.
A data de expiração é verificada também na instalação local. Um instalador
arquivado deixa de instalar quando seu manifest expira, mesmo offline; instalar
enquanto válido não causa expiração do motor já instalado.

Para preview, uma validade finita, por exemplo 30 dias, exige um responsável e
uma rotina de renovação. Com os mecanismos atuais, renovar significa emitir
metadata válida e reconstruir/revalidar o instalador com os inputs correspondentes;
o instalador antigo não consulta metadata nova para reparar seu manifest embutido.
Não remova a verificação de validade para esconder essa condição. Separar evidência
de instalação e descoberta de updates continua sendo trabalho aberto.

## Gates de publicação

- Verificar fontes/revisão escolhidas, builds, proveniência e testes do motor.
- Validar instalação, retomada após falhas, remoção e atualização, preservando
  versões em uso, sessões, configurações e PATH existente.
- Fazer QA visual de instalação e cancelamento em português; uma fixture CUDIA
  TEST com Registro isolado não comprova uma instalação no perfil de produção.
- Verificar Windows limpo e o comando `cudia` em um terminal novo, iniciado em
  outra pasta, sem ferramentas de desenvolvimento no PATH.
- Estabelecer custódia, recuperação, ledger e processo de rollover das chaves.
- Definir o host dos artefatos imutáveis e conferir downloads/redirects HTTPS com
  o cliente real. O serviço Node atual serve manifests; não serve os ZIPs ou EXEs.
- Confirmar projeto, branch, raiz `deploy/updates`, Node 22, npm, `server.js` e
  diretório durável de manifests na Hostinger. Conferir `/health`, `/ready` e o
  manifest, seguidos do download, verificação e ativação de uma atualização real.

A [documentação da Hostinger](https://www.hostinger.com/support/how-to-redeploy-a-node-js-application/)
descreve a revisão das configurações e informa que o redeploy GitHub usa a branch
selecionada. Isso não comprova a configuração atual de `cyara.com.br`.

Assinatura Ed25519 de releases e identidade de editor Authenticode são mecanismos
distintos. Um certificado Authenticode não está configurado neste checkout; não
declare o setup assinado por um editor sem certificado e verificação reais.
