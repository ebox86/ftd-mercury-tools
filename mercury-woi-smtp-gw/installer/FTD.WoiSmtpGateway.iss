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

; C# Windows service host
Source: "{#StageDir}\service-runtime\FTD.WoiSmtpGateway.ServiceHost.exe"; DestDir: "{app}\service-runtime"; Flags: ignoreversion
Source: "{#StageDir}\service-runtime\*.dll"; DestDir: "{app}\service-runtime"; Flags: ignoreversion skipifsourcedoesntexist

; Tray/configuration app
Source: "{#StageDir}\config-app\*"; DestDir: "{app}\config-app"; Flags: ignoreversion recursesubdirs createallsubdirs

; Ensure the service directory exists
; (Inno Setup will create it automatically when copying files)

; Service management scripts
Source: "{#StageDir}\service\install-woi-smtp-gateway.ps1"; DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#StageDir}\service\uninstall-woi-smtp-gateway.ps1"; DestDir: "{app}\service"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\FTD\WoiSmtpGateway"; Permissions: users-modify
Name: "{commonappdata}\FTD\WoiSmtpGateway\logs"; Permissions: users-modify
Name: "{commonappdata}\FTD\WoiSmtpGateway\mailqueue"; Permissions: users-modify

[Icons]
Name: "{group}\{#MyAppName} Configuration"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\config-app\WoiSmtpGatewayTray.ps1"""; WorkingDir: "{app}\config-app"
Name: "{group}\Start {#MyAppName} Tray Icon"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\config-app\WoiSmtpGatewayTray.ps1"" -Tray"; WorkingDir: "{app}\config-app"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{commonstartup}\{#MyAppName} Tray Icon"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\config-app\WoiSmtpGatewayTray.ps1"" -Tray"; WorkingDir: "{app}\config-app"

[Run]
; Install the Windows service after files are copied
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service\install-woi-smtp-gateway.ps1"" -AppRoot ""{app}"""; \
  Flags: runhidden waituntilterminated; StatusMsg: "Installing Windows service..."

; Start the per-user tray icon after installation
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\config-app\WoiSmtpGatewayTray.ps1"" -Tray"; \
  Flags: nowait runasoriginaluser skipifsilent; StatusMsg: "Starting tray configuration app..."

[UninstallRun]
; Stop the tray app before files are removed
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\config-app\WoiSmtpGatewayTray.ps1"" -ExitExisting"; \
  Flags: runhidden waituntilterminated; RunOnceId: "FTD.WoiSmtpGateway.ExitTray"

; Uninstall the Windows service
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service\uninstall-woi-smtp-gateway.ps1"" -AppRoot ""{app}"""; \
  Flags: runhidden waituntilterminated; RunOnceId: "FTD.WoiSmtpGateway.Uninstall.Service"

[InstallDelete]
; Optional: Clean up old files on upgrade
Type: filesandordirs; Name: "{app}\service\*.js"

