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
  #define StageDir "..\artifacts\installer\stage"
#endif

#ifndef SetupIconPath
  #define SetupIconPath "assets\fax-parser.ico"
#endif

#define MyAppName "FTD Fax Order Parser"
#define MyAppId "{{A7C24E31-08B2-4F9D-B6A3-2E5D91F83C47}}"
#define ServiceName "FTD Fax Order Parser"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName=C:\FTDTools\FaxOrderParser
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
Compression=lzma
SolidCompression=yes
OutputDir=..\dist
OutputBaseFilename=FTD.FaxOrderParser.Setup.{#MyAppVersion}
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\app-icon.ico
SetupLogging=yes
SetupIconFile={#SetupIconPath}
CloseApplications=yes
CloseApplicationsFilter=*FaxParserConfig.exe,*node.exe,*FTD.FaxParser.ServiceHost.exe

[Files]
; App icon
Source: "{#SetupIconPath}"; DestDir: "{app}"; DestName: "app-icon.ico"; Flags: ignoreversion

; Bundled Node.js runtime
Source: "{#StageDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs createallsubdirs ignoreversion restartreplace

; Compiled Node.js service (dist/service.js + node_modules)
Source: "{#StageDir}\service\*"; DestDir: "{app}\service"; Flags: recursesubdirs createallsubdirs ignoreversion restartreplace

; Tesseract trained data
Source: "{#StageDir}\service\eng.traineddata"; DestDir: "{app}\service"; Flags: ignoreversion skipifsourcedoesntexist restartreplace

; C# service host executable
Source: "{#StageDir}\service-runtime\FTD.FaxParser.ServiceHost.exe"; DestDir: "{app}\service-runtime"; Flags: ignoreversion restartreplace
Source: "{#StageDir}\service-runtime\*.dll"; DestDir: "{app}\service-runtime"; Flags: ignoreversion skipifsourcedoesntexist restartreplace

; WinForms config app (FaxParserConfig.exe + app-icon.ico)
Source: "{#StageDir}\config-app\*"; DestDir: "{app}\config-app"; Flags: recursesubdirs createallsubdirs ignoreversion restartreplace

; PowerShell helper scripts
Source: "{#StageDir}\service\install-fax-parser-service.ps1";   DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#StageDir}\service\uninstall-fax-parser-service.ps1"; DestDir: "{app}\service"; Flags: ignoreversion

[Dirs]
; Ensure the ProgramData config directory exists
Name: "{commonappdata}\FTD\FaxOrderParser"
Name: "C:\received_faxes"

[Icons]
; Start menu shortcut to the config app
Name: "{group}\{#MyAppName} Configuration"; Filename: "{app}\config-app\FaxParserConfig.exe"; IconFilename: "{app}\app-icon.ico"
Name: "{group}\Uninstall {#MyAppName}";    Filename: "{uninstallexe}"

; Desktop shortcut (optional — comment out to disable)
Name: "{userdesktop}\{#MyAppName} Configuration"; Filename: "{app}\config-app\FaxParserConfig.exe"; IconFilename: "{app}\app-icon.ico"

[Run]
; Install and start the Windows service after all files are placed
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service\install-fax-parser-service.ps1"" -AppRoot ""{app}"""; \
  StatusMsg: "Registering and starting Fax Order Parser service..."; \
  Flags: runhidden waituntilterminated

; Offer to open the config app immediately after install
; shellexec flag required: FaxParserConfig.exe has requireAdministrator manifest;
; ShellExecuteEx handles UAC correctly whereas CreateProcess cannot de-elevate to it.
Filename: "{app}\config-app\FaxParserConfig.exe"; \
  Description: "Open Fax Order Parser Configuration now"; \
  Flags: nowait postinstall skipifsilent shellexec

[UninstallRun]
; Stop and remove the Windows service before files are deleted
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service\uninstall-fax-parser-service.ps1"" -AppRoot ""{app}"""; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "FTD.FaxParser.Uninstall.Service"

[Code]
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
  Result := True;
end;

// Stop the service (and optionally the config app) before files are copied
// so that node.exe and FaxParserConfig.exe are not locked.
procedure StopExistingServiceAndApp();
var
  ResultCode: Integer;
begin
  // Stop the Windows service if it is installed and running
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop "FTD Fax Order Parser"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // Give sc.exe a moment for the process to actually release file handles
  Sleep(2000);

  // Kill the config app if it is open
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM FaxParserConfig.exe',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    StopExistingServiceAndApp();
end;
