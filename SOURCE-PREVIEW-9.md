# Fontes publicadas da Preview 9

Este snapshot publica a árvore completa de desenvolvimento usada pelo CUDIA,
incluindo a migração do motor, ferramentas, OAuth, testes, instalador e serviço
de atualizações. Está na branch `codex/preview-source`; `main` permanece na base
anterior. A publicação das fontes não troca os executáveis, os instaladores ou
o manifest ativo de `cyara.com.br`.

```powershell
git clone --branch codex/preview-source https://github.com/victorccronemberger-blip/cudia.git
cd cudia
```

## Correspondência com a distribuição

A Preview 9 distribui o motor
`1.18.35+cudia.a1c9471a1874.34d5ef8b73ad`. O commit-base registrado nos recibos
é `a1c9471a18743db1a41f858e3e1a278c9516f5d5`, acompanhado de uma árvore então
modificada. Este novo commit publica essa evolução; ele não é apresentado como
o commit que originalmente produziu os executáveis já distribuídos.

Os instaladores distribuídos usam Inno Setup. O diretório
`installer/windows/setup` conserva um protótipo de wrapper que não participa
do build nem dos instaladores da sequência 9.

Os recibos originais e os insumos públicos congelados estão em
[`provenance/preview-9`](provenance/preview-9). O relatório de correspondência
compara os blobs efetivamente publicados com os insumos registrados, distinguindo
bytes idênticos de normalização de finais de linha. A única alteração posterior
ao build no inventário de fontes do motor é o teste
`packages/opencode/test/server/cudia-backend-candidate.test.ts`: correções do alvo
semântico de upgrade e da finalização do proxy de teste. O conteúdo original
registrado também é preservado para conferência. Os fontes consumidos diretamente
pelo bundler correspondem aos insumos registrados.

O catálogo de modelos e o worker virtual do tree-sitter são os mesmos bytes
usados no build. Os fontes do cliente Go correspondem ao recibo da sequência 9,
com a substituição explícita de `trust.json` pelo keyring público durante o build.
Lockfile, patches e scripts de build fazem parte da árvore. Dependências de
terceiros são recuperadas pelo gerenciador de pacotes; `node_modules` não é publicado.

Os recibos delimitam a cobertura: plugins de build e seu acesso transitivo,
ambiente irrestrito e runtime-alvo gerenciado pelo Bun não foram integralmente
inventariados. Este snapshot não declara build hermético, reprodução bit a bit
ou equivalência entre um build novo e os binários da Preview 9.
As licenças do worker incluído e de sua dependência web-tree-sitter acompanham
os arquivos em `provenance/preview-9`.

## Compilação de desenvolvimento no Windows

Use Bun 1.3.14 e os requisitos de compilação descritos no README. Os comandos
abaixo são para desenvolvimento; o instalador de uso normal já inclui o runtime.

```powershell
bun install --frozen-lockfile
$env:MODELS_DEV_API_JSON = (Resolve-Path 'provenance/preview-9/models-api.json').Path
$env:OPENCODE_CHANNEL = 'cudia'
$env:OPENCODE_VERSION = '1.18.35+cudia.source.' + (git rev-parse --short=12 HEAD)
bun run --cwd packages/opencode script/build.ts --single --baseline --skip-install --skip-embed-web-ui --provenance --output-dir dist-source
```

Esse build tem uma identidade nova e não é promovido automaticamente para o
canal público. Para empacotar/publicar versões, siga o
[runbook de release](installer/windows/RELEASE-RUNBOOK.md). O keyring incluído é
público; a chave privada de assinatura e as credenciais de provedores ficam fora
desta publicação. Configurações pessoais e arquivos de diagnóstico locais não
fazem parte do snapshot.

## Validação da Preview distribuída

Instalação, PATH, abertura fria e remoção das variantes normal/baseline passaram
em [duas VMs Windows Server 2025 novas](https://github.com/victorccronemberger-blip/cudia/actions/runs/38901518617).
O publicador verificou os quatro downloads e ativou por último o manifest assinado.
A instalação física de trabalho atualizou de 6 para 9, preservou a versão anterior
e recebeu uma resposta Grok. O relatório de comparação de fontes não substitui
esses testes e não afirma que toda a monorepo foi testada integralmente.

A distribuição permanece Preview. Validação interativa como usuário comum em
Windows 10/11 e certificado de editor Authenticode continuam pendentes, assim
como os itens da meta geral indicados no roadmap.
