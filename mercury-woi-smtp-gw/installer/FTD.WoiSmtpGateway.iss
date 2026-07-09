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

#define MyAppName "FTD WOI SMTP Gateway"
#define MyAppId "{{B8E35F42-19C3-5G0E-C7B4-3F6E02G94D58}}"
#define ServiceName "FTD WOI SMTP Gateway"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName=C:\FTDTools\WoiSmtpGateway
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
Compression=lzma
SolidCompression=yes
OutputDir=..\dist
OutputBaseFilename=FTD.WoiSmtpGateway.Setup.{#MyAppVersion}
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#MyAppName}
SetupLogging=yes

[Files]
; Runtime (Node.js)
Source: "{#StageDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs

; Service files (compiled JavaScript)
Source: "{#StageDir}\service\*"; DestDir: "{app}\service"; Flags: ignoreversion recursesubdirs createallsubdirs

; Service management scripts
Source: "{#StageDir}\service\install-woi-smtp-gateway.ps1"; DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#StageDir}\service\uninstall-woi-smtp-gateway.ps1"; DestDir: "{app}\service"; Flags: ignoreversion

[Run]
; Install the Windows service after files are copied
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service\install-woi-smtp-gateway.ps1"""; \
  Flags: runhidden shellexec; StatusMsg: "Installing Windows service..."; Verb: runas

[UninstallRun]
; Uninstall the Windows service
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service\uninstall-woi-smtp-gateway.ps1"""; \
  Flags: runhidden shellexec; Verb: runas

[InstallDelete]
; Optional: Clean up old files on upgrade
Type: filesandordirs; Name: "{app}\service\*.js"

[Code]
function InitializeWizard: Boolean;
begin
  Result := True;
end;
