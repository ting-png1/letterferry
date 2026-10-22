param([Parameter(Mandatory=$true)][string]$ChatUrl)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$node=(Get-Command node.exe -ErrorAction Stop).Source
# No Win32 service: the browser must run in the signed-in Windows account.
$startup=[Environment]::GetFolderPath('Startup')
if(-not $startup){throw 'WINDOWS_STARTUP_FOLDER_UNAVAILABLE'}
$target=Join-Path $startup 'Riven Weixin Always Online.lnk'
$boot=Join-Path $root 'scripts\always-on-boot.ps1'
if(-not(Test-Path -LiteralPath $boot)){throw 'ALWAYS_ON_BOOT_SCRIPT_MISSING'}
# Enable after shortcut setup succeeds. Pausing or disabling changes the state
# without touching the paired peer or raw Weixin auth credentials.
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut($target)
$shortcut.TargetPath=(Get-Command powershell.exe).Source
$shortcut.Arguments='-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$boot+'"'
$shortcut.WorkingDirectory=$root
$shortcut.Description='LetterFerry - paired ChatGPT browser bridge, after Windows login'
$shortcut.WindowStyle=7
$shortcut.Save()
if(-not(Test-Path -LiteralPath $target -PathType Leaf)){throw 'WINDOWS_STARTUP_SHORTCUT_NOT_CREATED'}
& $node scripts/always-on-control.mjs enable $ChatUrl
if($LASTEXITCODE -ne 0){throw 'ALWAYS_ON_STATE_NOT_SAVED'}
'STARTUP_SHORTCUT_VERIFIED=TRUE'
'WINDOWS_LOGIN_AUTOSTART_CONFIGURED=TRUE'
'THIS_REQUIRES_EDGE_EXTENSION_V0_4_3_RELOADED_ONCE=TRUE'
