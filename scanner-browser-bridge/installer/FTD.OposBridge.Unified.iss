#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif

#ifndef MyAppPublisher
  #define MyAppPublisher "ebox86.com"
#endif

#ifndef MyAppURL
  #define MyAppURL "https://github.com/example/ftd-mercury-tools"
#endif

#ifndef StageDir
  #define StageDir "..\artifacts\installer-unified\stage"
#endif

#ifndef SetupIconPath
  #define SetupIconPath "assets\opos-bridge.ico"
#endif

#define MyAppName "FTD OPOS Bridge (Service + Agent)"
#define MyAppId "{{6D2CC7D2-D3E8-4FB6-A51C-BC4B3CC5A6F2}}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName=C:\FTDTools\OposBridgeUnified\package
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
Compression=lzma
SolidCompression=yes
OutputDir=..\dist
OutputBaseFilename=FTD.OposBridge.Unified.Setup.{#MyAppVersion}
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\app-icon.ico
SetupLogging=yes
SetupIconFile={#SetupIconPath}

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SetupIconPath}"; DestDir: "{app}"; DestName: "app-icon.ico"; Flags: ignoreversion

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "{code:GetInstallParameters}"; \
  StatusMsg: "Installing OPOS bridge service and task host..."; \
  Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "{code:GetUninstallParameters}"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "FTD.OposBridge.Unified.Uninstall"

[Code]
var
  CmdServiceName: string;
  CmdTaskName: string;
  CmdTrayTaskName: string;
  CmdInstallRoot: string;
  CmdLogicalName: string;
  CmdPort: string;
  CmdScannerMode: string;
  CmdLogLevel: string;
  CmdServiceAccount: string;
  CmdServiceUser: string;
  CmdUseAgentRelayHost: string;
  CmdNoTrayCompanion: string;
  CmdEnableTaskFallback: string;
  CmdKeepLegacyTask: string;
  CmdRemoveInstallRoot: string;

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

function NormalizeBool(const Value: string): string;
var
  V: string;
begin
  V := Lowercase(Trim(Value));
  if (V = '1') or (V = 'true') or (V = 'yes') or (V = 'on') then
  begin
    Result := 'true';
    Exit;
  end;

  if (V = '0') or (V = 'false') or (V = 'no') or (V = 'off') then
  begin
    Result := 'false';
    Exit;
  end;

  Result := '';
end;

function IsValidPort(const Value: string): Boolean;
var
  PortNumber: Integer;
begin
  PortNumber := StrToIntDef(Value, -1);
  Result := (PortNumber >= 1024) and (PortNumber <= 65535);
end;

function IsInCsvList(const Value: string; const CsvList: string): Boolean;
var
  Search: string;
begin
  Search := ',' + Lowercase(Trim(Value)) + ',';
  Result := Pos(Search, ',' + Lowercase(CsvList) + ',') > 0;
end;

function InitializeSetup(): Boolean;
begin
  CmdServiceName := ReadSwitchValue('SERVICENAME', 'FTD.OposBridge.Service');
  CmdTaskName := ReadSwitchValue('TASKNAME', 'FTD OPOS Bridge EXE');
  CmdTrayTaskName := ReadSwitchValue('TRAYTASKNAME', 'FTD OPOS Bridge Tray');
  CmdInstallRoot := ReadSwitchValue('INSTALLROOT', 'C:\FTDTools\OposBridgeService');
  CmdLogicalName := ReadSwitchValue('LOGICALNAME', 'ZEBRA_SCANNER');
  CmdPort := ReadSwitchValue('PORT', '17331');
  CmdScannerMode := Lowercase(ReadSwitchValue('SCANNERMODE', 'opos'));
  CmdLogLevel := Lowercase(ReadSwitchValue('LOGLEVEL', 'warning'));
  CmdServiceAccount := Lowercase(ReadSwitchValue('SERVICEACCOUNT', 'localservice'));
  CmdServiceUser := ReadSwitchValue('SERVICEUSER', '');
  CmdUseAgentRelayHost := NormalizeBool(ReadSwitchValue('USEAGENTRELAYHOST', 'true'));
  CmdNoTrayCompanion := NormalizeBool(ReadSwitchValue('NOTRAYCOMPANION', 'false'));
  CmdEnableTaskFallback := NormalizeBool(ReadSwitchValue('ENABLETASKFALLBACK', 'false'));
  CmdKeepLegacyTask := NormalizeBool(ReadSwitchValue('KEEPLEGACYTASK', 'false'));
  CmdRemoveInstallRoot := NormalizeBool(ReadSwitchValue('REMOVEINSTALLROOT', 'false'));

  if CmdServiceName = '' then
  begin
    MsgBox('SERVICENAME cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdTaskName = '' then
  begin
    MsgBox('TASKNAME cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdInstallRoot = '' then
  begin
    MsgBox('INSTALLROOT cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdLogicalName = '' then
  begin
    MsgBox('LOGICALNAME cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if not IsValidPort(CmdPort) then
  begin
    MsgBox('PORT must be an integer between 1024 and 65535.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if not IsInCsvList(CmdScannerMode, 'opos,mock') then
  begin
    MsgBox('SCANNERMODE must be opos or mock.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if not IsInCsvList(CmdLogLevel, 'trace,debug,information,warning,error,critical,none') then
  begin
    MsgBox('LOGLEVEL must be one of trace, debug, information, warning, error, critical, none.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if not IsInCsvList(CmdServiceAccount, 'localservice,networkservice,localsystem,current-user,custom') then
  begin
    MsgBox('SERVICEACCOUNT must be localservice, networkservice, localsystem, current-user, or custom.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if (CmdServiceAccount = 'custom') and (Trim(CmdServiceUser) = '') then
  begin
    MsgBox('SERVICEUSER is required when SERVICEACCOUNT=custom.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdUseAgentRelayHost = '' then
  begin
    MsgBox('USEAGENTRELAYHOST must be true/false.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdNoTrayCompanion = '' then
  begin
    MsgBox('NOTRAYCOMPANION must be true/false.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdEnableTaskFallback = '' then
  begin
    MsgBox('ENABLETASKFALLBACK must be true/false.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdKeepLegacyTask = '' then
  begin
    MsgBox('KEEPLEGACYTASK must be true/false.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdRemoveInstallRoot = '' then
  begin
    MsgBox('REMOVEINSTALLROOT must be true/false.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  Result := True;
end;

function GetInstallParameters(Param: string): string;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\scripts\install-opos-bridge-unified.ps1') +
    '" -ServiceName "' + CmdServiceName +
    '" -TaskName "' + CmdTaskName +
    '" -TrayTaskName "' + CmdTrayTaskName +
    '" -InstallRoot "' + CmdInstallRoot +
    '" -LogicalName "' + CmdLogicalName +
    '" -Port ' + CmdPort +
    ' -ScannerMode "' + CmdScannerMode +
    '" -LogLevel "' + CmdLogLevel +
    '" -ServiceAccount "' + CmdServiceAccount +
    '" -ServiceUser "' + CmdServiceUser +
    '" -UseAgentRelayHost:$' + CmdUseAgentRelayHost +
    ' -NoTrayCompanion:$' + CmdNoTrayCompanion +
    ' -EnableTaskFallback:$' + CmdEnableTaskFallback +
    ' -KeepLegacyTask:$' + CmdKeepLegacyTask;
end;

function GetUninstallParameters(Param: string): string;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\scripts\uninstall-opos-bridge-unified.ps1') +
    '" -ServiceName "' + CmdServiceName +
    '" -TaskName "' + CmdTaskName +
    '" -TrayTaskName "' + CmdTrayTaskName +
    '" -InstallRoot "' + CmdInstallRoot +
    ' -RemoveInstallRoot:$' + CmdRemoveInstallRoot;
end;
