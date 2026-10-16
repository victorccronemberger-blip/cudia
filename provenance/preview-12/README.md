# Preview 12

[release-evidence.json](release-evidence.json) registra os hashes, a identidade do motor e as verificações desta entrega.

- [x] Goal: preservar estado inválido ou ilegível, sem substituição silenciosa nem chamada ao provedor.
- [x] Auditoria opt-in: identificar preparação de compactação e checkpoints com bytes, hashes e origem; conteúdo completo continua explícito e limitado.
- [x] Resumos auxiliares V1: omitir snapshots de arquivos, mantendo o comportamento ordinário dos turnos.
- [x] 21 cenários compilados por variante, com 1.717 verificações em cada uma e encerramento/limpeza conferidos.
- [x] Dois instaladores testados em VMs Windows Server novas, com PATH, catálogo local e remoção.
- [x] Transição assinada 11 → 12 local nas duas variantes e atualização física por HTTPS neste PC, com CMD e resposta Grok.

O motor foi compilado de 881809bd1c2a4c92823bdf4ae0668a04ed004e50. A correção posterior do seletor da mensagem no teste está em 2d78d830eb498167b9bee4d193190244fd4675d3 e não altera os executáveis. A primeira execução normal encontrou esse erro de seleção; a suíte completa foi repetida com resultado aprovado. Os logs e hashes finais constam do JSON.

O cliente Windows da Preview 11 foi reutilizado byte a byte. O canal foi alterado após a qualificação dos mesmos quatro arquivos publicados. A CI corresponde à [tentativa 1](https://github.com/victorccronemberger-blip/cudia/actions/runs/38934887928).

Na [conferência posterior do executável instalado](desktop-final-check.json), CMD,
versão, atualização HTTPS e resposta ChatGPT com `openai/gpt-6-luna` passaram.
Autorização inicial e renovação forçada não foram repetidas neste motor.
Authenticode, validação interativa por usuário comum no Windows 10/11 e os demais
itens do roteiro continuam pendentes. Esta entrega não encerra a meta geral e não
altera o comportamento interno dos provedores.
