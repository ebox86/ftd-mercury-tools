#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif

#ifndef MyAppPublisher
  #define MyAppPublisher "FTD"
#endif

#ifndef MyAppURL
  #define MyAppURL "https://github.com/example/ftd-mercury-tools"
#endif

#ifndef StageDir
  #define StageDir "..\artifacts\installer\stage"
#endif

#define MyAppName "FTD Mercury Orders Dashboard"
#define MyAppId "{{2CFD7D74-C9C0-4660-A8BD-70AEF2E2505E}}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName=C:\FTDTools\MercuryOrdersDashboard
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
Compression=lzma
SolidCompression=yes
OutputDir=..\dist
OutputBaseFilename=FTD.MercuryDashboard.Setup.{#MyAppVersion}
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#MyAppName}
SetupLogging=yes

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "{code:GetInstallParameters}"; \
  StatusMsg: "Installing Mercury dashboard Windows services..."; \
  Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "{code:GetUninstallParameters}"; \
  Flags: runhidden waituntilterminated

[Code]
var
  CmdMercuryBase: string;
  CmdSoapNamespace: string;
  CmdBridgePort: string;
  CmdWebPort: string;
  CmdBridgeHost: string;
  CmdWebHost: string;
  CmdBridgeServiceName: string;
  CmdWebServiceName: string;
  CmdLocalNetworkOnly: string;

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
  PortNumber := StrToIntDef(Value, -1);
  Result := (PortNumber > 0) and (PortNumber < 65536);
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

function InitializeSetup(): Boolean;
begin
  CmdMercuryBase := ReadSwitchValue('MERCURYBASE', 'http://127.0.0.1/WsMercuryWebAPI');
  CmdSoapNamespace := ReadSwitchValue('SOAPNAMESPACE', 'http://localhost/webservices/');
  CmdBridgePort := ReadSwitchValue('BRIDGEPORT', '17344');
  CmdWebPort := ReadSwitchValue('WEBPORT', '5173');
  CmdBridgeHost := ReadSwitchValue('BRIDGEHOST', '0.0.0.0');
  CmdWebHost := ReadSwitchValue('WEBHOST', '0.0.0.0');
  CmdBridgeServiceName := ReadSwitchValue('BRIDGESERVICENAME', 'FTD Mercury Workflow Bridge');
  CmdWebServiceName := ReadSwitchValue('WEBSERVICENAME', 'FTD Mercury Dashboard Web');
  CmdLocalNetworkOnly := NormalizeBool(ReadSwitchValue('LOCALNETWORKONLY', 'true'));

  if CmdMercuryBase = '' then
  begin
    MsgBox('MERCURYBASE cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdSoapNamespace = '' then
  begin
    MsgBox('SOAPNAMESPACE cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if not IsValidPort(CmdBridgePort) then
  begin
    MsgBox('BRIDGEPORT must be an integer between 1 and 65535.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if not IsValidPort(CmdWebPort) then
  begin
    MsgBox('WEBPORT must be an integer between 1 and 65535.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdBridgePort = CmdWebPort then
  begin
    MsgBox('BRIDGEPORT and WEBPORT must be different.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdBridgeServiceName = '' then
  begin
    MsgBox('BRIDGESERVICENAME cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdWebServiceName = '' then
  begin
    MsgBox('WEBSERVICENAME cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdLocalNetworkOnly = '' then
  begin
    MsgBox('LOCALNETWORKONLY must be true/false (or 1/0, yes/no).', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  Result := True;
end;

function GetInstallParameters(Param: string): string;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\service\install-mercury-dashboard-services.ps1') +
    '" -NodeExePath "' + ExpandConstant('{app}\runtime\node.exe') +
    '" -NssmExePath "' + ExpandConstant('{app}\bin\nssm.exe') +
    '" -BridgeServiceName "' + CmdBridgeServiceName +
    '" -WebServiceName "' + CmdWebServiceName +
    '" -BridgePort ' + CmdBridgePort +
    ' -WebPort ' + CmdWebPort +
    ' -MercuryBaseUrl "' + CmdMercuryBase +
    '" -MercurySoapNamespace "' + CmdSoapNamespace +
    '" -MercuryLocalNetworkOnly "' + CmdLocalNetworkOnly +
    '" -BridgeHost "' + CmdBridgeHost +
    '" -WebHost "' + CmdWebHost + '"';
end;

function GetUninstallParameters(Param: string): string;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\service\uninstall-mercury-dashboard-services.ps1') +
    '" -NssmExePath "' + ExpandConstant('{app}\bin\nssm.exe') +
    '" -BridgeServiceName "' + CmdBridgeServiceName +
    '" -WebServiceName "' + CmdWebServiceName + '"';
end;
