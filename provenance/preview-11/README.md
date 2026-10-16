# Preview 11

[release-evidence.json](release-evidence.json) registra a identidade, os quatro downloads,
os hashes e a validação desta publicação. O motor foi compilado do commit
`2daad05e1bb326acf30b117f22a1c6e399e55794`; a documentação da qualificação e o timeout de prontidão
da fixture são posteriores, sem alteração no código do motor.

Cada ZIP inclui os recibos em `defaults/cudia-engine-build.json`,
`defaults/engine-inputs.json` e `defaults/cudia-package-build.json`.
O catálogo congelado é o mesmo de [Preview 9](../preview-9/models-api.json).
Inventários observados não provam uma build hermética ou reprodutibilidade bit a bit.

Os 20 testes compilados passaram em cada variante, com 1.597 verificações por
variante, incluindo primeira execução com o ZIP publicado e LSP real. Os mesmos
instaladores passaram em duas VMs Windows Server 2025 novas
([CI, tentativa 1](https://github.com/victorccronemberger-blip/cudia/actions/runs/38917808771)).
Os assets ficaram públicos como candidata identificada para a CI com acesso
somente leitura; o canal 10 permaneceu ativo até a qualificação. O manifest
assinado foi alterado por último. A instalação física desta máquina atualizou
por HTTPS de 10 para 11, abriu pelo CMD e respondeu via Grok na conta existente.

ChatGPT, autorização inicial e renovação forçada não foram repetidos para este
motor. Certificado Authenticode e validação interativa em Windows 10/11 por
usuário comum permanecem pendentes. A meta geral continua ativa.
