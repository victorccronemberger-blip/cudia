# Preview 13

[release-evidence.json](release-evidence.json) registra os hashes, a identidade do motor e as verificações desta entrega.

- [x] Histórico SQLite opcional: metadados de contexto, desligado por padrão, retenção e paginação limitadas.
- [x] Auditoria dos loaders selecionados: recibos e posições observadas na requisição preparada, com lacunas explícitas.
- [x] Adaptador nativo: preservar texto e imagens suportadas e corrigir rejeição de base64 válido de 8 MiB.
- [x] Normal: 21 cenários na mesma rodada, 1.717 verificações. Baseline: cobertura segmentada dos mesmos 21 cenários, com os dois timeouts das rodadas completas preservados. O cenário adicional de contexto/imagens passou com 27 verificações por variante.
- [x] Dois instaladores testados em VMs Windows Server novas, com PATH, catálogo local e remoção.
- [x] Transição assinada 12 → 13 local nas duas variantes e atualização física por HTTPS neste PC, com CMD e resposta Grok.

O motor foi compilado de 832e3f3741f03c62de06962e2595726f6b63c13f. Os testes posteriores de contexto/imagens e diagnóstico de plugins estão em 7e754df72eb76bf11463ab43673440106bab0cf8 e não alteram os executáveis. Duas rodadas completas baseline tiveram um timeout de 120 segundos em cenários diferentes, LSP e plugins. Os testes isolados passaram com os prazos originais e a cobertura segmentada confere os mesmos nomes dos 21 cenários da variante normal. A causa dos timeouts permanece desconhecida; estabilidade da suíte completa não foi comprovada. Os registros de falha e hashes constam do JSON.

O cliente Windows da Preview 12 foi reutilizado byte a byte. O canal foi alterado após a qualificação dos mesmos quatro arquivos publicados. A CI corresponde à [tentativa 1](https://github.com/victorccronemberger-blip/cudia/actions/runs/38958058086).

Fallback integral de imagens não suportadas e igualdade dos bytes com auditoria ligada/desligada foram testados nos fontes; não no teste compilado adicional. Inferência real com imagens não foi repetida. ChatGPT, autorização inicial e renovação forçada não foram repetidos neste motor. Authenticode, validação interativa por usuário comum no Windows 10/11 e os demais itens do roteiro continuam pendentes. Esta entrega não encerra a meta geral e não altera o comportamento interno dos provedores.
