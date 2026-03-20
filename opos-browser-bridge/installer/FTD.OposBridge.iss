#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif

#ifndef MyAppPublisher
  #define MyAppPublisher "FTD"
#endif

#ifndef MyAppURL
  #define MyAppURL "https://github.com/example/ftd-mercury-tools"
#endif

#define MyAppName "FTD OPOS Bridge"
#define MyAppId "{{B3B056A6-93E0-4CDA-B97D-54FA36E2864E}}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName=C:\FTDTools\OposBridge
DefaultGroupName=FTD OPOS Bridge
DisableProgramGroupPage=yes
DisableDirPage=yes
Compression=lzma
SolidCompression=yes
OutputDir=..\dist
OutputBaseFilename=FTD.OposBridge.Setup.{#MyAppVersion}
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#MyAppName}
SetupLogging=yes

[Files]
Source: "..\opos-scanner-bridge.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\install-opos-bridge-task.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\uninstall-opos-bridge-task.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "{code:GetInstallTaskParameters}"; \
  StatusMsg: "Configuring OPOS bridge startup task..."; \
  Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "{code:GetUninstallTaskParameters}"; \
  Flags: runhidden waituntilterminated

[Code]
var
  CmdLogicalName: string;
  CmdPort: string;
  CmdTaskName: string;

function ReadSwitchValue(const SwitchName: string; const DefaultValue: string): string;
var
  I: Integer;
  Candidate: string;
  Prefix: string;
begin
  Result := DefaultValue;
  Prefix := '/' + Uppercase(SwitchName) + '=';

  for I := 1 to ParamCount do
  begin
    Candidate := ParamStr(I);
    if Pos(Prefix, Uppercase(Candidate)) = 1 then
    begin
      Result := Copy(Candidate, Length(Prefix) + 1, MaxInt);
      Exit;
    end;
  end;
end;

function IsValidPort(const Value: string): Boolean;
var
  PortNumber: Integer;
begin
  Result := TryStrToInt(Value, PortNumber) and (PortNumber > 0) and (PortNumber < 65536);
end;

function InitializeSetup(): Boolean;
begin
  CmdLogicalName := ReadSwitchValue('LOGICALNAME', 'ZEBRA_SCANNER');
  CmdPort := ReadSwitchValue('PORT', '17331');
  CmdTaskName := ReadSwitchValue('TASKNAME', 'FTD OPOS Scanner Bridge');

  if CmdLogicalName = '' then
  begin
    MsgBox('LOGICALNAME cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if not IsValidPort(CmdPort) then
  begin
    MsgBox('PORT must be an integer between 1 and 65535.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  Result := True;
end;

function GetInstallTaskParameters(Param: string): string;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\install-opos-bridge-task.ps1') +
    '" -BridgeScriptPath "' + ExpandConstant('{app}\opos-scanner-bridge.ps1') +
    '" -LogicalName "' + CmdLogicalName +
    '" -Port ' + CmdPort +
    ' -TaskName "' + CmdTaskName + '"';
end;

function GetUninstallTaskParameters(Param: string): string;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\uninstall-opos-bridge-task.ps1') +
    '" -TaskName "' + CmdTaskName +
    '" -BridgeScriptPath "' + ExpandConstant('{app}\opos-scanner-bridge.ps1') + '"';
end;
