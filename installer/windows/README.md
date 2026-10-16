# Distribuição Windows do CUDIA

Este diretório prepara o pacote nativo, o cliente de atualizações e o wizard.
A compilação e os fluxos silenciosos do instalador já foram executados com o
motor real e Registro isolado. A QA interativa CUDIA TEST também foi concluída.
A [Preview pública](https://github.com/victorccronemberger-blip/cudia/releases/tag/cudia-preview-20261016-1b9ea9a042e6)
tem instaladores normal/baseline, `cudia` no PATH e atualização HTTPS assinada
conferida nas transições 1 → 2, 2 → 3 e 3 → 5. A sequência 4 foi retirada antes
da publicação. Windows limpo e qualificação stable continuam
pendentes; o teste de perfil/PATH isolados não certifica um sistema novo.

A qualificação também precisa ocorrer fora do processo empacotado que a prepara.
Em 16/10, o MSIX do Codex redirecionou uma instalação para a área privada do app:
o PATH ficou correto, mas o CMD externo não via os arquivos. A instalação desta
máquina foi reparada e verificada por um processo sem identidade de pacote,
com resolução de `cudia`, versão, SHA256 do motor e caminho físico por handle.
A preparação automática do instalador quando aberto por um app MSIX está sendo
integrada em fonte e ainda não faz parte da Preview pública sequência 5. Uma consulta interna bem-sucedida não prova visibilidade
do executável no ambiente normal do Windows.

O protótipo com iniciador Go compilou, mas seu executável foi bloqueado pelo
Windows Defender antes de iniciar o wizard no ensaio completo. Ele não está
qualificado nem publicado. Os testes nativos separados passaram; não substituem
o fluxo completo. Nenhuma configuração do Defender foi alterada.

O backend de preparação, ativação, propriedade do PATH e remoção inventariada
já existe. O [contrato de manutenção](INSTALLER-TRANSACTIONS.md) descreve os
comandos do helper, a recuperação e os gates restantes da distribuição.

## Preparar ou compilar o wizard

`build-installer.ps1` recebe um cliente compilado com as chaves públicas da release,
o bundle e sua manifest assinada. Os caminhos são entradas confiáveis do processo
de build. O script copia e congela esses arquivos em um diretório privado, valida
a assinatura com o helper, confere que o helper é exatamente o launcher do pacote
e testa o bootstrap em uma instalação temporária. Ele não executa o motor nessa
validação, não altera a configuração do usuário e não gera chaves privadas.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\installer\windows\build-installer.ps1 `
  -BootstrapPath C:\build\cudia.exe -LauncherPath C:\build\launcher.exe `
  -ManifestPath C:\releases\preview.json -ArchivePath C:\releases\cudia.zip `
  -Channel preview -Variant normal -PrepareOnly `
  -OutputDirectory C:\build\prepared-installer
```

`-PrepareOnly` produz entradas verificadas e `build-info.json` com `compiled: false`;
não produz um instalador `.exe`. O diretório de saída deve ser novo. Ele inclui o
código do wizard, os arquivos públicos e seus hashes; não inclui a árvore temporária
de validação. Esse modo permite validar o preparo sem um compilador instalado.

Para compilar, omita `-PrepareOnly`, escolha outro diretório de saída novo e
forneça `-CompilerPath C:\Tools\Inno\ISCC.exe`. O script também aceita o
compilador disponível no PATH. Ele não baixa nem instala compiladores.
O usuário final recebe um executável autossuficiente e não precisa instalar
Go, Inno, Node.js, Bun ou Git para usar o runtime incluído.
Após sucesso, retorna caminho, tamanho e SHA-256 do instalador em `output/`.
Compilar não executa o wizard nem valida uma publicação: `validatedForPublication`
permanece `false` até os gates externos de release serem atendidos.

O build usa diretamente o wizard Inno e registra `packaging: "inno-setup"`.
O protótipo de iniciador Go permanece sem qualificação e não participa do build
de distribuição. O helper verifica o caminho físico de uma gravação exclusiva em
AppData e do destino antes de preparar arquivos, PATH ou registro. Se o aplicativo
que abriu o setup redirecionar o sistema de arquivos, o wizard pede que o setup
completo seja aberto pelo desktop normal do Windows; não informa instalação
concluída em uma área privada invisível ao CMD. A transição automática a partir
de aplicativos MSIX continua pendente. Este fluxo ainda não possui uma identidade
de editor Authenticode configurada.

O wizard usa instalação por usuário, oferece o PATH e preserva a pasta de trabalho
de futuras aberturas. Seus arquivos são extraídos apenas em temporários: o helper
nativo coordena a preparação, a ativação e o registro em Aplicativos instalados.
O Inno não substitui arquivos do aplicativo ou encerra sessões abertas. Instalação,
reexecução do instalador íntegro e desinstalação foram verificadas no modo silencioso
com Registro isolado. Isso não promete reparar payloads alterados, trocar um bootstrap
diferente nem substituir os testes interativos ou de uma release pública.

O pacote instalado usará um bootstrap fixo em `bin/cudia.exe`, uma versão
selecionada por `state/activation.json` e diretórios separados em `versions/`.
O cliente verifica manifests Ed25519 e os arquivos de cada pacote. Atualizações
selecionam a versão da próxima abertura; não substituem executáveis de sessões
que já estão abertas. Os comandos e limites estão no [README do cliente](launcher/README.md).

## Construir o cliente

Em uma máquina de desenvolvimento com Go 1.27, execute:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\installer\windows\build-client.ps1 -GoPath C:\Go\bin\go.exe
```

O script compila em uma cópia temporária, sem dependências externas, e preserva
os builds existentes. Retorna os caminhos dos executáveis e a identificação
da chave pública incorporada. Sem `-PublicKeysPath`, o cliente contém um conjunto
vazio de chaves e informa que atualizações estão desabilitadas.

Para um build de distribuição, `-PublicKeysPath` recebe um JSON de chaves
públicas Ed25519 no formato aceito pelo serviço. O script valida esse conjunto
no executável compilado. Ele não gera chaves privadas, não altera o arquivo de
confiança do checkout e não permite substituir a confiança por variável de
ambiente ou pelo arquivo de conexão. Definir as chaves de produção e a custódia
da assinatura ainda faz parte da publicação final.

Cada build também produz `client-build.json`, sem caminhos absolutos, contendo
os hashes e tamanhos das fontes Go copiadas, `go.mod`, confiança pública
incorporada, script de build, executável Go e dois executáveis resultantes.
Registra a versão do Go/PowerShell, os argumentos e os quatro overrides de
ambiente aplicados. As fontes congeladas são conferidas antes e depois da
compilação. O módulo atual usa somente a biblioteca padrão e incorpora apenas
`trust.json`; não há `go.sum`, assembly ou outros assets incorporados.
Esse registro cobre os inputs descritos, sem afirmar um build hermético ou
reproduzível byte a byte, nem inventariar toda a configuração herdada do processo
ou todos os arquivos internos da instalação Go.

## Construir o motor com proveniência

Use o Bun exigido pelo checkout e dependências instaladas com o lockfile congelado.
Builds com proveniência exigem `--skip-install`: a instalação de dependências
deve terminar antes de carregar plugins, evitando medir arquivos novos enquanto
o processo ainda usa módulos antigos já carregados.
Selecione uma versão de motor e um snapshot JSON do catálogo de modelos. Da raiz:

```powershell
$env:OPENCODE_CHANNEL = 'cudia'
$env:OPENCODE_VERSION = '1.18.35+cudia.release.1'
$env:MODELS_DEV_API_JSON = 'C:\build\models-api.json'
bun run --cwd packages/opencode script/build.ts --single --baseline `
  --skip-install --skip-embed-web-ui --provenance --output-dir dist-release
```

O comando é um exemplo de build local, sem publicação. `--provenance` compila
primeiro numa saída privada para descobrir os inputs do bundler. Depois mede
esses arquivos e compila o resultado final com uma nova instância do plugin,
exigindo o mesmo conjunto de inputs, bytes observados e parâmetros efetivos.
As fontes Git declaradas e o executável Bun também são conferidos antes/depois.
Cada variante recebe `engine-build.json` e `engine-inputs.json` ao lado de `bin/`.
O hash/tamanho do motor vêm do `.exe` final, não do tamanho intermediário de JS
reportado pelo bundler. O smoke test compara a versão efetivamente executada.

O recibo tem limite de 1 MiB e referencia um inventário separado de até 4 MiB,
sem truncamento. Ele registra hashes de modelos/arquivos virtuais e os parâmetros
usados; não distribui cópias completas dos fontes ou do snapshot de modelos.
O escopo inclui fontes Git nomeadas, inputs observados do bundler e entradas
explícitas do plugin de build. Leituras transitivas do plugin, resolução,
ambiente herdado e o runtime de destino administrado pelo Bun não são totalmente
inventariados. Isso não atesta hermeticidade, reprodutibilidade ou revisão
independente do builder. O modo de release do script também exige proveniência;
builds comuns de desenvolvimento continuam usando uma única compilação.

## Construir um pacote

Depois de compilar e validar um motor com suporte a `CUDIA_DISTRIBUTION_DIR`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\installer\windows\package.ps1 `
  -EnginePath C:\build\engine.exe -LauncherPath C:\build\launcher.exe `
  -ClientBuildInfoPath C:\build\client-build.json `
  -EngineBuildInfoPath C:\build\engine-build.json -RequireEngineProvenance `
  -Version 1.0.0-preview.1 -Sequence 1 -Channel preview -Variant normal `
  -OutputPath C:\releases\cudia-1.0.0-preview.1-windows-x64.zip
```

O exemplo descreve a sintaxe; essa versão não é uma release publicada. O arquivo
de saída deve ser novo e sua pasta deve existir. O script retorna tamanho,
SHA-256 e identidade para produzir o manifest pelo
[publicador de versões](../../deploy/updates/README.md). Os metadados retornados
não provam que o motor fornecido foi compilado da revisão correta: essa validação
pertence ao build e aos testes de release.

O pacote inclui `defaults/cudia-package-build.json`, com identidade da release,
hashes do motor/launcher realmente copiados, script/PowerShell e inventário dos
defaults. Com `-ClientBuildInfoPath`, inclui também os bytes exatos do registro
do cliente e exige que seu launcher corresponda ao arquivo empacotado. Esses
registros entram no descritor e ficam vinculados à assinatura do arquivo ZIP.
O runtime não os adiciona ao prompt. Com `-EngineBuildInfoPath`, o empacotador
exige correspondência dos bytes, variante e destino, confere o inventário irmão
`engine-inputs.json` e inclui ambos no ZIP autenticado. O estado passa a
`engineSource: "observed-build"`, com os limites declarados pelo recibo. A versão
do motor pode diferir da versão do bundle; o vínculo com o executável é seu hash.
Sem recibo, permanece `not-recorded`: o checkout de empacotamento não comprova a
origem de um arquivo recebido. `-RequireEngineProvenance` impede essa ausência em
um processo de release que exige evidência. Não cria recibos retroativamente.

O preparo do instalador confere o registro autenticado contra o descritor, os
defaults, o helper, o bootstrap e a confiança realmente incorporada. Também confere
o recibo do motor e seu inventário quando o pacote declara `observed-build`. Registros
antigos ausentes continuam explicitamente ausentes. `build-info.json` registra
esses vínculos, a validade do manifest e os hashes do compilador/setup;
`completed: true` indica que a operação de build terminou, sem atestar publicação.

O ZIP contém o descritor `package.json`, launcher, motor e uma seleção explícita
dos defaults do repositório: configuração, agentes, comandos, skills, glossário,
tema e fontes do bridge opcional. Os hashes são calculados sobre os arquivos
copiados para o pacote. Não inclui `node_modules`, `.env`, plugins de smoke,
tipos de desenvolvimento ou testes. A cópia distribuída de `tui.json` perde
somente as declarações de plugins; o arquivo do checkout permanece intacto.

O motor lê esses defaults com baixa precedência, sem tratar essa pasta como
diretório gravável de configuração. Configuração, credenciais e sessões do
usuário continuam fora dos diretórios de versão. Plugins/políticas executáveis
de pacote não são uma forma suportada de distribuir defaults.

O pacote omite as escolhas pessoais `model` e `small_model` do checkout.
A primeira execução permite conectar uma conta e escolher seu modelo, mantendo
as escolhas explícitas da configuração do usuário/projeto. O motor, o bootstrap
e o launcher são distribuídos no instalador; iniciar `cudia` não requer Git,
Bun, Node ou .NET no PATH.

Os MCPs continuam desabilitados por padrão. A Preview sequência 5 prepara
Node portátil, o pacote MCP fixado e Chromium automaticamente em Windows x64, no cache do
usuário, apenas ao conectar `cudia-browser`; a primeira preparação exige Internet.
O ZIP assinado foi instalado numa raiz privada e executado pelo bootstrap com
perfil/cache vazios e PATH System32: navegação, JavaScript, clique, reuso do cache
e encerramento dos processos passaram. Esse teste não substitui Windows limpo.
O bridge Claude requer suas dependências npm e Claude CLI em um ambiente gravável
preparado separadamente. O pacote inclui suas fontes, mas não provisiona as
dependências desse bridge nem garante que ativá-lo já seja suficiente.
Os comandos `ai-deps`, `changelog`, `commit`, `issues`, `rmslop` e `translate`
recebem variantes portáveis de `defaults/command` durante o empacotamento.
Descobrem o contexto do projeto atual e mantêm o modelo selecionado, sem depender
de scripts do checkout CUDIA ou de um repositório GitHub fixo. Os comandos originais
do checkout permanecem intactos. O teste confere os textos e hashes no ZIP; não
declara que executou esses workflows com um modelo. A skill Effect continua
específica de projetos com Effect v4, e a operação das integrações opcionais ainda
precisa de validação no ambiente instalado. Os agentes auxiliares `triage`,
`kali` e `duplicate-pr` ainda declaram modelos próprios; esta alteração dos
comandos não remove essas escolhas de configuração.

## Conexão e atualizações

`connection.json` é o template do arquivo de conexão consumido pelo cliente.
Aponta para `https://cyara.com.br/updates/v1/stable.json`; um pacote preview usa
o canal e endereço preview correspondentes. O arquivo não contém uma chave
confiável. O cliente implementa consulta/aplicação explícitas por
`cudia update --check` e `cudia update`. Novas instalações habilitam
`automaticCheck: true`: ao abrir uma sessão interativa, uma consulta vencida
é executada em segundo plano, sem esperar a resposta para iniciar o motor.
O intervalo padrão é 24 horas; falhas também aguardam pelo menos 24 horas.
Conexões existentes e tickets antigos de instalação mantêm sua política.
Uma sessão continuamente aberta não agenda consultas periódicas.

O aviso usa um manifesto assinado em cache, revalidado na próxima abertura;
não há download nem aplicação automática. Sair do motor cancela e aguarda
a consulta. Sem chaves públicas compiladas não há consulta automática.
Cache desconhecido ou adulterado é preservado e suspende essas consultas.
Os testes usam chaves e HTTPS privados; publicação e atualização real em
`cyara.com.br` continuam pendentes.

Os testes usam instalações temporárias. O teste compilado do wizard usa uma
cópia de build com destinos exclusivos de Registro e PATH; não há substituição
desses destinos por CLI ou ambiente no cliente de produção. Esses testes não
alteram o PATH do usuário nem instalam uma release de produção. Assinatura de release Ed25519 e assinatura
Authenticode do instalador são entregas diferentes; não há certificado
Authenticode configurado aqui.

## Validação

Execute a partir deste diretório:

```powershell
node --test test/package.test.mjs
$env:CUDIA_GO_PATH='C:\Go\bin\go.exe'
node --test test/interop.test.mjs
```

Os testes do empacotador usam um executável PE do Windows como dado, sem
executá-lo como harness. O teste de interoperabilidade gera chaves temporárias,
constrói o cliente com a chave pública apenas na cópia de build, usa o publicador
Node real e inicializa a instalação pelo cliente Go real. Para verificar também
o motor compilado, forneça seu caminho absoluto antes de executar esse teste:

```powershell
$env:CUDIA_REAL_ENGINE='C:\build\opencode.exe'
$env:CUDIA_ENGINE_BUILD_INFO='C:\build\engine-build.json'
node --test test/interop.test.mjs
```

Nesse modo, o bootstrap inicia o harness de uma pasta externa com PATH sem
Git/Bun/Node. O teste confere precedência de configuração, disponibilidade de
read/edit/bash/task na Arena mesmo com deny legado e preservação das preferências.
Também mantém seu próprio servidor
aberto, cria uma sessão V2 sem chamar um provedor, instala uma segunda versão e
confere que a sessão antiga continua acessível e novas aberturas selecionam a
versão nova. Isso não testa uma geração LLM em andamento durante a atualização.
Todos os processos e instalações são temporários; o teste não publica o endereço
de artefato nem substitui o motor da sessão do usuário.
Com `CUDIA_ENGINE_BUILD_INFO`, também confere o recibo/inventário efetivamente
instalados e a preparação do setup com proveniência obrigatória. O teste do wizard
aceita a mesma variável para validar seu fluxo compilado com esses metadados.

Para verificar também o preparo e o wizard compilado, forneça um compilador
Inno Setup existente. A validação atual usou Inno Setup 7.1.0 portátil, Go 1.27.2,
Node.js 22 e PowerShell 5:

```powershell
$env:CUDIA_GO_PATH='C:\Go\bin\go.exe'
$env:CUDIA_INNO_COMPILER='C:\Tools\Inno\ISCC.exe'
$env:CUDIA_REAL_ENGINE='C:\build\opencode.exe'
node --test --test-concurrency=1 test/package.test.mjs test/installer-build.test.mjs test/installer-wizard.test.mjs test/interop.test.mjs
```

A validação compilada confere instalação, reexecução sem duplicar PATH,
desinstalação, assinatura inválida e compensação após falha de finalização. Com
o motor real, cria uma sessão V2 sem enviar prompt a provedor e confere que os
bytes de SQLite e dos WAL/SHM presentes permanecem iguais após desinstalar.
Também verifica a recusa de remoção com seu servidor aberto e a preservação
das chaves reais do Registro. Auxiliares próprios, recibos e locks desaparecem;
um arquivo desconhecido em `state` permanece e uma segunda instalação sem
arquivos desconhecidos perde sua raiz vazia. As páginas interativas e o cancelamento precisam
de QA manual; os testes silenciosos não comprovam esses comportamentos.

O teste compilado também provoca quedas reais sem defers em oito fronteiras de
transferência/restauração, com instalações independentes para cada comando normal
e silencioso: 16 cenários. Executa literalmente os comandos registrados, incluindo
a recuperação sem exclusões seguida da segunda invocação nativa. Somente os
diálogos são substituídos na cópia privada para essa cobertura sem interação;
os hashes dessas mudanças constam no perfil de teste. A GUI distribuída permanece
inalterada e precisa de QA visual. Execute Go e Node em sequência: a recusa de
remoção considera o inventário global de processos do Windows.

Os testes adicionais `test/client-build-provenance.test.mjs` e
`test/trust-rotation.test.mjs` verificam os registros e a transição A → A+B → B.
O [procedimento de release](RELEASE-RUNBOOK.md) distingue rollover de chaves,
manutenção do bootstrap, validade dos manifests e gates de publicação.

Para exportar a fixture do wizard para QA visual, defina
`CUDIA_WIZARD_QA_OUTPUT` como um diretório absoluto novo ao executar apenas
`test/installer-wizard.test.mjs` com as dependências acima. A saída contém um
instalador marcado CUDIA TEST, helper e perfil local, sem a chave privada.
Seus destinos de Registro/PATH são isolados e o manifest tem validade finita.
Essa fixture não é o instalador de produção e seu perfil contém caminhos locais.
