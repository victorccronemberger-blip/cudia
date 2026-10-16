; Compile only through build-installer.ps1. The native helper owns application
; files, PATH, registration and recovery; Inno extracts temporary inputs only.
#include "bundle.iss"

#if CudiaChannel == "preview"
  #define CudiaDisplayName "CUDIA Preview"
  #define CudiaFolderName "Cudia Preview"
  #define CudiaRegistryName "CudiaPreview"
#else
  #define CudiaDisplayName "CUDIA"
  #define CudiaFolderName "Cudia"
  #define CudiaRegistryName "Cudia"
#endif

[Setup]
AppId=Cudia.{#CudiaChannel}
AppName={#CudiaDisplayName}
AppVersion={#CudiaVersion}
AppPublisher=CUDIA Project
AppPublisherURL=https://cyara.com.br
AppSupportURL=https://github.com/victorccronemberger-blip/cudia
DefaultDirName={code:DefaultInstallDirectory}
DisableDirPage=no
DisableProgramGroupPage=yes
DisableWelcomePage=no
UsePreviousAppDir=no
UsePreviousTasks=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
WizardSizePercent=110
; The helper creates this directory during PrepareToInstall. Enabling the
; destination page keeps /DIR and WizardDirValue bound to the selected path.
; Inno installs no application files into it.
CreateAppDir=yes
Uninstallable=no
CloseApplications=no
RestartApplications=no
AlwaysRestart=no
ChangesEnvironment=yes
SetupLogging=yes
SetupMutex=Cudia.Setup.{#CudiaChannel}
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir=output
OutputBaseFilename={#CudiaOutputName}
VersionInfoVersion={#CudiaFileVersion}
VersionInfoTextVersion={#CudiaVersion}
VersionInfoProductName={#CudiaDisplayName}
VersionInfoDescription=Instalador do {#CudiaDisplayName}

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "path"; Description: "Adicionar o comando cudia ao PATH do meu usuario"; Flags: checkedonce

[Files]
Source: "launcher.exe"; Flags: dontcopy
Source: "cudia.exe"; Flags: dontcopy
Source: "release.json"; Flags: dontcopy
Source: "bundle.zip"; Flags: dontcopy

[Code]
var
  HelperExtracted: Boolean;
  HelperReady: Boolean;
  InstallationSucceeded: Boolean;
  Finalizing: Boolean;
  InstallationFailed: Boolean;
  PreparedRoot: String;
  PreparedTicket: String;
  LastHelperLine: String;
  FailureText: String;

function DefaultInstallDirectory(Param: String): String;
var
  Previous: String;
begin
  Result := ExpandConstant('{localappdata}\{#CudiaFolderName}');
  if RegQueryStringValue(HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#CudiaRegistryName}',
    'InstallLocation', Previous) and (Previous <> '') then
    Result := Previous;
end;

function Quote(const Value: String): String;
begin
  { A final separator must not escape the closing quote in Windows argv. }
  Result := '"' + Value;
  if (Length(Value) > 0) and (Value[Length(Value)] = '\') then
    Result := Result + '\';
  Result := Result + '"';
end;

procedure HelperLog(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
  if Trim(S) <> '' then
    LastHelperLine := Copy(S, 1, 1000);
end;

function RunHelper(const Operation, Arguments: String): Boolean;
var
  Code: Integer;
begin
  LastHelperLine := '';
  Code := -1;
  try
    Result := ExecAndLogOutput(ExpandConstant('{tmp}\launcher.exe'),
      'installer ' + Operation + ' --root ' + Quote(PreparedRoot) + ' ' + Arguments,
      ExpandConstant('{tmp}'), SW_SHOWNORMAL, ewWaitUntilTerminated, Code, @HelperLog);
  except
    Log(GetExceptionMessage);
    Result := False;
  end;
  Result := Result and (Code = 0);
  if not Result then
    Log('CUDIA helper failed: operation=' + Operation + ', exit=' + IntToStr(Code));
end;

procedure ExtractAndVerifyHelper;
begin
  if HelperExtracted then
    Exit;
  ExtractTemporaryFile('launcher.exe');
  if Lowercase(GetSHA256OfFile(ExpandConstant('{tmp}\launcher.exe'))) <> '{#CudiaHelperSHA256}' then
    RaiseException('O helper do instalador nao passou na verificacao. Obtenha uma copia valida.');
  HelperExtracted := True;
end;

function InitializeSetup: Boolean;
var
  Code: Integer;
begin
  Result := False;
  try
    ExtractAndVerifyHelper;
    Code := -1;
    LastHelperLine := '';
    Result := ExecAndLogOutput(ExpandConstant('{tmp}\launcher.exe'),
      'installer context-check', ExpandConstant('{tmp}'), SW_HIDE,
      ewWaitUntilTerminated, Code, @HelperLog) and (Code = 0);
    if not Result then
      RaiseException('O Windows redirecionou os arquivos deste instalador. ' +
        'Abra o instalador completo do CUDIA pela area de trabalho e tente novamente.');
  except
    Log(GetExceptionMessage);
    if not WizardSilent then
      SuppressibleMsgBox(GetExceptionMessage, mbError, MB_OK, IDOK);
    Result := False;
  end;
end;

procedure ExtractAndVerifyInputs;
begin
  if HelperReady then
    Exit;
  ExtractAndVerifyHelper;
  ExtractTemporaryFile('cudia.exe');
  ExtractTemporaryFile('release.json');
  ExtractTemporaryFile('bundle.zip');
  if (Lowercase(GetSHA256OfFile(ExpandConstant('{tmp}\launcher.exe'))) <> '{#CudiaHelperSHA256}') or
    (Lowercase(GetSHA256OfFile(ExpandConstant('{tmp}\cudia.exe'))) <> '{#CudiaBootstrapSHA256}') or
    (Lowercase(GetSHA256OfFile(ExpandConstant('{tmp}\release.json'))) <> '{#CudiaManifestSHA256}') or
    (Lowercase(GetSHA256OfFile(ExpandConstant('{tmp}\bundle.zip'))) <> '{#CudiaArchiveSHA256}') then
    RaiseException('Os arquivos do instalador nao passaram na verificacao. Obtenha uma copia valida.');
  HelperReady := True;
end;

function IsTicket(const Value: String): Boolean;
var
  I: Integer;
begin
  Result := Length(Value) = 64;
  if not Result then
    Exit;
  for I := 1 to Length(Value) do
    if Pos(Value[I], '0123456789abcdef') = 0 then
    begin
      Result := False;
      Exit;
    end;
end;

function AbortPrepared: Boolean;
begin
  Result := True;
  if (PreparedTicket <> '') and HelperReady then
  begin
    Result := RunHelper('wizard-abort', '--ticket ' + Quote(PreparedTicket));
    if Result then
      PreparedTicket := '';
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  TicketFile, Arguments, AddPath: String;
  TicketBytes: AnsiString;
begin
  Result := '';
  if not AbortPrepared then
  begin
    Result := 'Nao foi possivel recuperar a tentativa anterior. Consulte o registro da instalacao.';
    Exit;
  end;
  PreparedRoot := RemoveBackslashUnlessRoot(WizardDirValue);
  Log('CUDIA destination: ' + PreparedRoot);
  try
    ExtractAndVerifyInputs;
    TicketFile := ExpandConstant('{tmp}\cudia-wizard-ticket.txt');
    if FileExists(TicketFile) then
      RaiseException('Ja existe uma confirmacao nesta tentativa. Feche e execute novamente o instalador.');
    AddPath := 'false';
    if WizardIsTaskSelected('path') then
      AddPath := 'true';
    Arguments := '--manifest ' + Quote(ExpandConstant('{tmp}\release.json')) +
      ' --archive ' + Quote(ExpandConstant('{tmp}\bundle.zip')) +
      ' --bootstrap ' + Quote(ExpandConstant('{tmp}\cudia.exe')) +
      ' --channel {#CudiaChannel} --variant {#CudiaVariant} --add-path=' + AddPath +
      ' --ticket-output ' + Quote(TicketFile);
    if not RunHelper('wizard-prepare', Arguments) then
    begin
      Result := 'Nao foi possivel preparar o CUDIA. ' +
        'Consulte o registro da instalacao para corrigir o problema e tente novamente.';
      Exit;
    end;
    if not LoadStringFromFile(TicketFile, TicketBytes) then
      RaiseException('Nao foi possivel ler a confirmacao de preparacao.');
    PreparedTicket := Trim(String(TicketBytes));
    if not IsTicket(PreparedTicket) then
    begin
      PreparedTicket := '';
      RaiseException('A confirmacao de preparacao e invalida. Execute novamente este instalador para recuperar.');
    end;
    DeleteFile(TicketFile);
  except
    Log(GetExceptionMessage);
    Result := GetExceptionMessage;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then
    Exit;
  Finalizing := True;
  try
    InstallationSucceeded := (PreparedTicket <> '') and
      RunHelper('wizard-finalize', '--ticket ' + Quote(PreparedTicket));
    InstallationFailed := not InstallationSucceeded;
    if InstallationSucceeded then
    begin
      { Native abort recognizes committed activation and only cleans metadata. }
      if not AbortPrepared then
        Log('A instalacao foi concluida; a limpeza sera retomada na proxima manutencao.');
    end
    else
    begin
      FailureText := 'Nao foi possivel concluir o CUDIA. Consulte o registro da instalacao e execute ' +
        'novamente este instalador para recuperar a tentativa.';
      if not AbortPrepared then
        Log('A tentativa necessita de recuperacao pelo instalador.');
    end;
  finally
    Finalizing := False;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID <> wpFinished then
    Exit;
  if InstallationSucceeded then
  begin
    if WizardIsTaskSelected('path') then
      WizardForm.FinishedLabel.Caption := 'O CUDIA esta pronto. Abra um novo terminal na pasta do seu ' +
        'projeto e execute cudia. Suas conversas e configuracoes permanecem no seu perfil de usuario.'
    else
      WizardForm.FinishedLabel.Caption := 'O CUDIA esta pronto. Inicie-o pelo caminho ' +
        Quote(PreparedRoot + '\bin\cudia.exe') +
        '. Suas conversas e configuracoes permanecem no seu perfil de usuario.';
  end
  else if InstallationFailed then
  begin
    WizardForm.FinishedHeadingLabel.Caption := 'Instalacao nao concluida';
    WizardForm.FinishedLabel.Caption := FailureText;
  end;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if Finalizing then
    Cancel := False;
end;

procedure DeinitializeSetup;
begin
  if not InstallationSucceeded then
    if not AbortPrepared then
      Log('A preparacao sera recuperada ao executar novamente este instalador.');
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := 0;
  if InstallationFailed then
    Result := 73;
end;
