; OPOS POSPrinter OCX
; Copy the OCX to the install directory and register it
Source: "{#MyAppAssets}\OPOSPOSPrinter.ocx"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "regsvr32.exe"; Parameters: "/s \"{app}\OPOSPOSPrinter.ocx\""; StatusMsg: "Registering OPOSPOSPrinter.ocx..."; Flags: runhidden

[Files]
Source: "{#MyAppAssets}\star.reg"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "regedit.exe"; Parameters: "/s \"{app}\star.reg\""; StatusMsg: "Importing Star POSPrinter registry settings..."; Flags: runhidden
