# Preview 10

[release-evidence.json](release-evidence.json) registra a identidade, os quatro downloads,
os hashes e a validação desta publicação. O motor foi compilado do commit
`3c53ad68ceff6926e6b6844b474080cc00e98b5b`; esta documentação e o ajuste de prazo do publicador são posteriores.

Cada ZIP inclui os recibos em `defaults/cudia-engine-build.json`,
`defaults/engine-inputs.json` e `defaults/cudia-package-build.json`.
O catálogo congelado é o mesmo arquivo de [Preview 9](../preview-9/models-api.json).
Inventários observados não provam uma build hermética ou reprodutibilidade bit a bit.

Os instaladores passaram em duas VMs Windows Server 2025 novas
([CI, tentativa 2](https://github.com/victorccronemberger-blip/cudia/actions/runs/38909722028/attempts/2)).
A tentativa 1 terminou antes da instalação, com HTTP 403 ao acessar a Draft.
Os mesmos assets foram publicados como candidata identificada, sem ativar o canal;
a repetição passou antes da ativação. O canal assinado foi alterado por último.
A instalação desta máquina atualizou por HTTPS de 9 para 10 e respondeu via ChatGPT e Grok.
