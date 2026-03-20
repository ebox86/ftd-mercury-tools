# Private Winget Deployment (FTD OPOS Bridge)

This package is designed for private/internal rollout.

## 1. Build + Release

Trigger GitHub Actions workflow:
- `.github/workflows/opos-bridge-release.yml`
- Tag format: `opos-bridge-v1.0.0`
- Or run manually with workflow input `version`

Release artifacts include:
- `FTD.OposBridge.Setup.<version>.exe`
- SHA256 file
- generated winget manifests zip

## 2. Publish Manifests to Your Private Source

The workflow generates manifests and uploads them as a build artifact and release asset.
From there, publish them into your private winget source using your existing process/tooling.

## 3. Add Private Source on Workstations

Example (REST source):

```powershell
winget source add --name ftd-mercury-tools --arg "https://your-winget-source.example.com" --type Microsoft.Rest --accept-source-agreements
winget source list
```

## 4. Install / Upgrade / Uninstall

Install:

```powershell
winget install --id FTD.OposBridge -s ftd-mercury-tools -e
```

Install with custom scanner settings:

```powershell
winget install --id FTD.OposBridge -s ftd-mercury-tools -e --override "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LOGICALNAME=ZEBRA_SCANNER /PORT=17331 /TASKNAME=""FTD OPOS Scanner Bridge"""
```

Upgrade:

```powershell
winget upgrade --id FTD.OposBridge -s ftd-mercury-tools -e
```

Uninstall:

```powershell
winget uninstall --id FTD.OposBridge -s ftd-mercury-tools -e
```

## 5. Hosting Note (Important)

`InstallerUrl` in manifests must be reachable by client machines.

- If your GitHub repo/releases are private, client machines usually cannot download installer assets anonymously.
- For private rollout, prefer an internal HTTPS host or another authenticated distribution path supported by your private source setup.
