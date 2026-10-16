# Contrato de manutenção do instalador Windows

Este documento descreve as interfaces do helper nativo usado pelo wizard. Execute
o helper extraído pelo instalador fora da árvore da instalação. Os comandos básicos
de preparação exigem um destino existente, absoluto e sem aliases ou reparse points.
O coordenador `wizard-prepare` também pode criar um destino novo. A compilação e os
testes de um instalador isolado não constituem uma release de produção publicada.

## Coordenador do wizard

O wizard usa `installer wizard-prepare`, `installer wizard-finalize` e
`installer wizard-abort`. As opções de preparação são as do comando básico abaixo,
mais `--add-path=true|false`. O ticket continua sendo persistido em um arquivo novo.
Uma nova execução reconhece seus próprios journals e recupera a tentativa anterior.
Transações básicas criadas manualmente não são adotadas como se fossem do wizard.

Antes da preparação interna, o coordenador persiste `state/wizard-intent.json`
com ticket reservado, identidade do bundle/bootstrap e estado anterior. Isso
permite recuperar uma queda antes da criação de `wizard-pending.json`, sem
precisar do ticket que ainda não chegou ao Inno. A recuperação só aborta uma
preparação própria com correspondência estrita e estado anterior intacto; journals
manuais, divergentes ou já em commit são preservados. Staging sem recibo não é
adotado nem apagado por suposição. As APIs básicas recusam journals do wizard.

O coordenador controla os arquivos `bin/cudia.exe` e `maintenance/launcher.exe`,
o PATH e a entrada por usuário em Aplicativos instalados. A preparação verifica
o helper contra os bytes do launcher da release assinada. A finalização registra
propriedade e as mudanças no Registro antes de ativar o motor; alterações posteriores
de outros programas não são desfeitas por suposição. A identidade de arquivo Windows
persiste antes de promover os executáveis, permitindo reconhecer a própria promoção
depois de uma interrupção, inclusive quando outra cópia tem bytes idênticos.

O Inno usa `Uninstallable=no`, não registra o aplicativo e extrai os quatro arquivos
de entrada somente em temporários. `CreateAppDir=yes` mantém a escolha de pasta e
`/DIR` funcionais; o helper já cria esse destino durante a preparação. O Inno não
copia arquivos do aplicativo para a pasta escolhida. A falha de finalização produz
código de saída 73 e uma página de conclusão que informa a falha.

As chaves de produção são fixas em HKCU:

- `Software\Microsoft\Windows\CurrentVersion\Uninstall\Cudia` para stable.
- `Software\Microsoft\Windows\CurrentVersion\Uninstall\CudiaPreview` para preview.
- `Environment\Path` para o comando do usuário.

Não há opção CLI ou variável de ambiente que substitua esses destinos do Registro.
Os testes do instalador compilam uma cópia privada com destinos exclusivos de teste;
a cópia distribuída continua usando os destinos fixos acima.

## Desinstalação coordenada

A entrada em Aplicativos instalados executa o helper de manutenção. Ele confere
seus próprios bytes, prepara um processo auxiliar e aguarda a confirmação do filho
antes de terminar. O filho confere a identidade do pai e aguarda sua saída sem
encerrar processos. O modo normal pede confirmação; o modo quiet é usado nos testes.

Antes de apagar qualquer payload, o cliente persiste o plano completo e uma cópia
de recuperação conferida por hash e identidade de arquivo fora da instalação, em
`%LOCALAPPDATA%\CudiaMaintenanceRecovery\<hash-da-raiz>\uninstall-<id>\launcher.exe`.
Ambos os comandos de desinstalação no Registro passam a apontar para essa cópia
durável e são conferidos novamente. Ela permite repetir uma remoção interrompida
mesmo depois de apagar o helper original e a ativação. A entrada de recuperação
permanece até a última operação de remoção do Registro.

A operação mantém lease exclusiva durante a limpeza do payload, bootstrap, helper,
conexão conhecida e PATH. Preserva conexões editadas, arquivos desconhecidos, sessões
e credenciais. Os arquivos do aplicativo precisam ter os bytes conhecidos antes da
primeira remoção. Uma cópia ausente durante o retry é aceita; uma cópia modificada
é preservada e precisa de manutenção explícita.

A limpeza final usa um recibo imutável fora da instalação e um journal tipado
`CudiaCleanup` no Registro. Reservas precedem a criação dos auxiliares; a confirmação
registra hash, tamanho e identidade Windows. Um caminho reservado que já existe sem
confirmação é preservado. O mutex Global por SID real e chave do aplicativo também
coordena instalações em raízes diferentes; objetos preexistentes com proprietário
ou DACL divergente são recusados.

A fase de arquivos da raiz exige os três locks originais abertos exclusivamente
e confere todos os metadados restantes antes de remover qualquer um deles. A fase
seguinte é persistida e descarregada no Registro antes de remover os locks. Uma
retomada dessa fase não pode apagar metadados da raiz. Depois de fechar os locks,
somente handles já conferidos de diretórios vazios podem ser removidos. Arquivos
desconhecidos e novas gerações permanecem.

Com a raiz concluída, ambos os comandos de Aplicativos instalados passam para um
programa estático executado pelo PowerShell 5 do System32. Ele depende do Windows
e do journal no Registro, sem precisar do helper ou de outro arquivo de recuperação.
A transferência exige readback e flush. Falhas durante a transferência ou antes
da confirmação do executor restauram os comandos nativos quando a autoridade e
os arquivos conferidos permanecem íntegros. Um executor atrasado revalida o modo
atual sob o mutex antes de apagar arquivos.

Uma queda abrupta também pode deixar os comandos PowerShell gravados e o handoff
ainda incompleto. Nessa situação, a invocação registrada sem contexto de pai tem
somente autoridade para recuperar os comandos nativos. Confere todo o inventário
presente, vincula os dois comandos ao helper atual e ao recibo pareado e restaura
cada comando com readback e flush. Só então confirma o modo nativo no journal.
Não remove arquivos e informa que é preciso repetir a desinstalação; o modo quiet
retorna erro de retry. Uma segunda invocação usa o comando nativo registrado,
inclusive quando a raiz já desapareceu. Entradas históricas confirmadas e ausentes
não são adotadas nem recriadas. Arquivos presentes divergentes impedem a recuperação.

Esse programa só remove auxiliares externos confirmados. Confere caminho local
canônico, ausência de reparse points, identidade, link único, tamanho e hash no
mesmo handle. Permite leitores existentes e bloqueia escritores; a remoção POSIX
do nome preserva a leitura já aberta. Em filesystem incompatível ou contenção além
do prazo, mantém a recuperação. Diretórios precisam estar vazios. Só depois da
ausência conferida de todos os alvos externos a chave inteira é removida, encerrando
comandos e recibo juntos. Não há processo residente nem tarefa de reboot.

O JSON `uninstall-started`, `wizard-remove-started` ou `cleanup-started` confirma
o início da operação assíncrona. O diálogo de sucesso só aparece depois da remoção
final da chave. A limpeza não promete remover arquivos pessoais ou desconhecidos.

## Preparação e ativação

```powershell
launcher.exe installer prepare --root C:\Cudia `
  --manifest C:\bundle\preview.json --archive C:\bundle\cudia.zip `
  --bootstrap C:\bundle\cudia.exe --channel preview --variant normal `
  --ticket-output C:\temporary\new-ticket.txt
```

O arquivo de ticket deve ser novo. O helper retorna também JSON com `ticket`,
`releaseId`, `version`, `variant` e `channel`. A preparação verifica a assinatura
com as chaves compiladas, copia e verifica os bytes do pacote em staging próprio
e guarda um journal limitado em `state/install-pending.json`. Não troca o motor
ativo, a conexão ou o bootstrap. Se já existe um bootstrap, seus bytes precisam
coincidir com o bootstrap fornecido: manutenção de um bootstrap diferente ainda
exige um fluxo separado, que não foi implementado.

Após o wizard instalar o bootstrap correspondente em `bin/cudia.exe` e concluir
suas demais operações, ele pode solicitar a ativação:

```powershell
launcher.exe installer commit --root C:\Cudia --ticket TICKET
launcher.exe installer abort --root C:\Cudia --ticket TICKET
```

O commit confere novamente assinatura, prazo, inventário, arquivos e bootstrap,
e recusa mudanças na ativação ou conexão desde a preparação. A substituição
atômica de `activation.json` é a última operação substantiva; limpeza posterior
não transforma uma ativação bem-sucedida em erro. Uma conexão ausente é criada
com o canal preparado e o endereço correspondente em `cyara.com.br`.

O ticket permite repetir o commit após uma interrupção. O abort limpa apenas
staging/journal próprios; depois de um commit bem-sucedido, serve para limpar
seus metadados sem desfazer a ativação. Ele nunca restaura uma versão anterior
ou apaga uma versão promovida. Um journal inacabado bloqueia novos updates e
rollback até sua recuperação; o motor anterior pode continuar funcionando.
Essas são as APIs básicas. O coordenador descrito acima também controla seus
próprios arquivos, Registro e PATH. Não há transação atômica entre Registro,
Inno Setup e sistema de arquivos.

## PATH por usuário

```powershell
launcher.exe installer path-add --root C:\Cudia
launcher.exe installer path-remove --root C:\Cudia
```

Esses comandos usam apenas `HKCU\Environment\Path`. Não alteram o PATH deste
processo ou da máquina. O cliente preserva tipo e tokens existentes, reconhece
entradas equivalentes e só registra propriedade quando acrescenta uma entrada.
O journal está em `state/path-ownership.json`. Repair mantém essa propriedade;
remover uma entrada previamente existente não é permitido.

Edições ambíguas, duplicatas e interrupções entre o Registro e o journal fazem
o cliente preservar a entrada e informar necessidade de revisão manual. O CLI
retorna erro para `pending`, impedindo declarar a tarefa concluída silenciosamente.
As releituras antes da escrita reduzem disputas, mas não fornecem compare-and-swap
contra outros programas que editem o PATH simultaneamente. O wizard deve compensar
apenas mudanças comprovadamente pertencentes à sua tentativa, preservar propriedade
de instalações anteriores e orientar a abertura de um novo terminal.

## Remoção do payload

```powershell
launcher.exe installer preflight-uninstall --root C:\Cudia
launcher.exe installer remove-payload --root C:\Cudia
```

Bootstrap e launcher mantêm leases compartilhadas até o motor terminar. Remoção
exige lease exclusiva e lock de update; updates continuam permitidos com motores
abertos. O cliente também consulta imagens de processos para detectar motores
antigos ou executados diretamente, sem encerrá-los. Enquanto houver uso ou uma
identidade relevante não puder ser conferida, a remoção é recusada.

O preflight não remove arquivos. A remoção confere todos os arquivos conhecidos
antes de começar, guarda um journal de recuperação e apaga somente os arquivos
inventariados, removendo a ativação por último. Um arquivo modificado impede a
remoção inicial; arquivos já ausentes podem ser tratados ao repetir uma remoção.
Junctions, short names e hard links não ampliam o inventário. Arquivos desconhecidos
e diretórios não vazios são preservados e listados como remanescentes.

Essa API básica remove apenas o payload. A desinstalação coordenada acima também
trata bootstrap, conexão, helper, registro do aplicativo e PATH sob sua propriedade.
Ela não percorre diretórios XDG, credenciais ou sessões. Não usa remoção recursiva,
encerramento forçado de processos nem remoção agendada para o reinício.

## Consulta automática e propriedade do cache

Novas conexões preparadas pelo wizard habilitam consultas automáticas.
Tickets antigos com a política desabilitada continuam válidos; uma conexão
existente é preservada byte a byte. O recibo de propriedade aceita as duas
formas canônicas geradas pelo instalador.

A consulta só começa em abertura interativa quando o intervalo vence e há
chaves públicas compiladas. Um mutex efêmero separado serializa consultas;
ele não acrescenta outro arquivo de lock ao protocolo de remoção. O launcher
cancela e aguarda seu worker antes de liberar a lease de execução.

A limpeza coordenada inclui `state/update-check.json` somente se o handle
aberto comprovar arquivo regular, único link, esquema estrito e raiz correta.
Registra identidade, tamanho e hash no inventário existente. Expiração da
assinatura não invalida propriedade estrutural do cache. Conteúdo desconhecido
nesse nome é preservado; a limpeza final continua exigindo os três locks
originais. Temporários de consultas interrompidas não são adotados ou coletados.

## Gates restantes

- Concluir QA visual e de cancelamento nas páginas interativas em português.
- Verificar o instalador em Windows limpo, incluindo os destinos padrão do Registro,
  PATH em um terminal novo e sessões abertas.
- Definir manutenção do bootstrap, rotação de confiança e retenção de versões.
- Provisionar chaves de produção, publicar artefatos e validar HTTPS/Hostinger.

Os testes de PATH usam uma chave HKCU isolada por teste e não o PATH real do
usuário. O teste composto Node/PowerShell/Go usa o motor CUDIA real quando
`CUDIA_REAL_ENGINE` está definido; não chama provedores. Isso não substitui os
gates do wizard acima.
