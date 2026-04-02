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

#ifndef SetupIconPath
  #define SetupIconPath "assets\mercury-dashboard.ico"
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
SetupIconFile={#SetupIconPath}

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Run]
Filename: "{app}\service-runtime\FTD.Mercury.Dashboard.ServiceHost.exe"; \
  Parameters: "{code:GetInstallBridgeParameters}"; \
  StatusMsg: "Installing Mercury workflow bridge service..."; \
  Flags: runhidden waituntilterminated
Filename: "{app}\service-runtime\FTD.Mercury.Dashboard.ServiceHost.exe"; \
  Parameters: "{code:GetInstallWebParameters}"; \
  StatusMsg: "Installing Mercury dashboard web service..."; \
  Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{app}\service-runtime\FTD.Mercury.Dashboard.ServiceHost.exe"; \
  Parameters: "{code:GetUninstallWebParameters}"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "FTD.MercuryDashboard.Uninstall.Web"
Filename: "{app}\service-runtime\FTD.Mercury.Dashboard.ServiceHost.exe"; \
  Parameters: "{code:GetUninstallBridgeParameters}"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "FTD.MercuryDashboard.Uninstall.Bridge"

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

function QuoteCmdValue(const Value: string): string;
begin
  Result := '"' + Value + '"';
end;

function InitializeSetup(): Boolean;
begin
  if not IsAdminInstallMode then
  begin
    MsgBox(
      'This installer must run in Administrator mode to register Windows services. ' +
      'Please restart setup and allow elevation.',
      mbCriticalError,
      MB_OK);
    Result := False;
    Exit;
  end;

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

function GetInstallBridgeParameters(Param: string): string;
begin
  Result :=
    '--service-install ' +
    '--service-role=bridge ' +
    '--service-name=' + QuoteCmdValue(CmdBridgeServiceName) + ' ' +
    '--bridge-port=' + CmdBridgePort + ' ' +
    '--bridge-host=' + QuoteCmdValue(CmdBridgeHost) + ' ' +
    '--mercury-base-url=' + QuoteCmdValue(CmdMercuryBase) + ' ' +
    '--mercury-soap-namespace=' + QuoteCmdValue(CmdSoapNamespace) + ' ' +
    '--mercury-local-network-only=' + CmdLocalNetworkOnly;
end;

function GetInstallWebParameters(Param: string): string;
begin
  Result :=
    '--service-install ' +
    '--service-role=web ' +
    '--service-name=' + QuoteCmdValue(CmdWebServiceName) + ' ' +
    '--depends-on-service=' + QuoteCmdValue(CmdBridgeServiceName) + ' ' +
    '--web-port=' + CmdWebPort + ' ' +
    '--web-host=' + QuoteCmdValue(CmdWebHost) + ' ' +
    '--workflow-api-base-url=' + QuoteCmdValue('http://127.0.0.1:' + CmdBridgePort);
end;

function GetUninstallWebParameters(Param: string): string;
begin
  Result :=
    '--service-uninstall ' +
    '--service-role=web ' +
    '--service-name=' + QuoteCmdValue(CmdWebServiceName);
end;

function GetUninstallBridgeParameters(Param: string): string;
begin
  Result :=
    '--service-uninstall ' +
    '--service-role=bridge ' +
    '--service-name=' + QuoteCmdValue(CmdBridgeServiceName);
end;
