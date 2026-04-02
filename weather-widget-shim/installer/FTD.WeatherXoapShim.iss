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
  #define SetupIconPath "assets\weather-widget-shim.ico"
#endif

#define MyAppName "FTD Weather XOAP Shim"
#define MyAppId "{{12A4A152-BEA2-4E9D-8D89-D7F3D6B58D4A}}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName=C:\FTDTools\XoapWeatherShim\package
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
Compression=lzma
SolidCompression=yes
OutputDir=..\dist
OutputBaseFilename=FTD.WeatherXoapShim.Setup.{#MyAppVersion}
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
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "{code:GetInstallParameters}"; \
  StatusMsg: "Installing Weather XOAP shim in IIS..."; \
  Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "{code:GetUninstallParameters}"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "FTD.WeatherXoapShim.Uninstall"

[Code]
var
  CmdSiteName: string;
  CmdHostName: string;
  CmdInstallRoot: string;
  CmdSkipHostsEntry: string;
  CmdSkipIisPrereqs: string;
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

function InitializeSetup(): Boolean;
begin
  CmdSiteName := ReadSwitchValue('SITENAME', 'FTD.XoapWeatherShim');
  CmdHostName := ReadSwitchValue('HOSTNAME', 'xoap.weather.com');
  CmdInstallRoot := ReadSwitchValue('INSTALLROOT', 'C:\FTDTools\XoapWeatherShim');
  CmdSkipHostsEntry := NormalizeBool(ReadSwitchValue('SKIPHOSTSENTRY', 'false'));
  CmdSkipIisPrereqs := NormalizeBool(ReadSwitchValue('SKIPIISPREREQS', 'false'));
  CmdRemoveInstallRoot := NormalizeBool(ReadSwitchValue('REMOVEINSTALLROOT', 'false'));

  if CmdSiteName = '' then
  begin
    MsgBox('SITENAME cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdHostName = '' then
  begin
    MsgBox('HOSTNAME cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdInstallRoot = '' then
  begin
    MsgBox('INSTALLROOT cannot be empty.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdSkipHostsEntry = '' then
  begin
    MsgBox('SKIPHOSTSENTRY must be true/false (or 1/0, yes/no).', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdSkipIisPrereqs = '' then
  begin
    MsgBox('SKIPIISPREREQS must be true/false (or 1/0, yes/no).', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  if CmdRemoveInstallRoot = '' then
  begin
    MsgBox('REMOVEINSTALLROOT must be true/false (or 1/0, yes/no).', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  Result := True;
end;

function GetInstallParameters(Param: string): string;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\scripts\install-weather-xoap-shim.ps1') +
    '" -SiteName "' + CmdSiteName +
    '" -HostName "' + CmdHostName +
    '" -InstallRoot "' + CmdInstallRoot +
    '" -SkipHostsEntry:$' + CmdSkipHostsEntry +
    ' -SkipIisPrereqs:$' + CmdSkipIisPrereqs;
end;

function GetUninstallParameters(Param: string): string;
begin
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\scripts\uninstall-weather-xoap-shim.ps1') +
    '" -SiteName "' + CmdSiteName +
    '" -HostName "' + CmdHostName +
    '" -InstallRoot "' + CmdInstallRoot +
    ' -RemoveInstallRoot:$' + CmdRemoveInstallRoot;
end;
