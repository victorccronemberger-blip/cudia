# Consultor automático do Drael

A consulta automática é uma opção local de execução. Não acrescenta instruções
ao system prompt e não troca o modelo principal: Drael executa, o subagente
configurado fornece um parecer visível como chamada de `task`.

Para habilitar, crie `consultation.json` no diretório global de configuração
(no Windows, normalmente `%USERPROFILE%\.config\opencode`):

```json
{
  "enabled": true,
  "agent": "sol-consultor",
  "providers": ["drael"],
  "mode": "technical",
  "maxConsultations": 2,
  "maxContextChars": 12000
}
```

O subagente precisa existir na configuração e ter um modelo e permissões próprios.
A permissão do executor para chamar esse subagente continua sendo respeitada.
Sem esse arquivo, ou com `enabled: false`, não há consulta automática.

Pedidos reconhecidos como programação ou trabalho com várias etapas consultam
antes da primeira execução do modelo principal. A classificação é heurística.
Se ela não reconhecer o pedido, a primeira ferramenta de trabalho é adiada,
o parecer é obtido e o executor recebe o resultado antes de repetir a ação.
Leituras, descoberta de ferramentas e controles de Goal passam diretamente.

Uma consulta adicional pode ocorrer após dois novos erros de ferramentas.
O limite padrão é de duas tentativas automáticas por pedido, compartilhadas
durante o mesmo Goal, inclusive após compactação ou mensagens de orientação.
Interrupções e falhas da consulta são registradas; uma falha comum do consultor
permite ao executor continuar. Cancelar a execução interrompe também a consulta.
Consultas manuais permanecem disponíveis.

O pacote inicial contém o pedido, sem copiar toda a conversa ou resultados de
leitura. A recuperação acrescenta diagnósticos limitados dos erros. Referências
`@arquivo` nesse pacote são texto, sem leitura automática de arquivos.

## Experimento de contexto

O teto local do Drael permite até 240.000 tokens. Para solicitar essa janela,
configure `provider.drael.models.drael-v1.limit.context` como `240000`;
se houver um limite `input` menor, ajuste-o também. Metadados nativos menores
continuam valendo quando não há substituição explícita. Os demais provedores
mantêm o teto local de 248.000.

Esse ajuste muda o orçamento local e o momento da compactação. A aceitação e a
qualidade efetiva dessa janela dependem do servidor do provedor; uma resposta
curta bem-sucedida não comprova o processamento de 240.000 tokens.

## Modelo de compactação

O compactador pode usar um modelo e um nível de raciocínio independentes do
executor. Para usar Terra em medium, adicione à configuração global:

```json
{
  "agent": {
    "compaction": {
      "model": "openai/gpt-6.1-terra",
      "variant": "medium",
      "options": { "reasoningEffort": "medium" }
    }
  }
}
```

A variante explícita do compactador tem precedência. Um modelo de compactação
fixado sem variante própria usa as opções desse modelo, sem herdar a variante do
executor. Quando não há substituição do modelo nem da variante do compactador,
a variante da sessão continua sendo usada. Essa escolha não altera o modelo
principal nem a mensagem original da sessão.
