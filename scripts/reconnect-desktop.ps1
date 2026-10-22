param([switch]$Quiet,[switch]$DryRun)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
function Report([string]$code,[string]$message,[bool]$warning=$false){
 Write-Output ('RECONNECT_RESULT '+$code)
 Write-Output $message
 if(-not $Quiet){
  try{
   $shell=New-Object -ComObject WScript.Shell
   $style=if($warning){48}else{64}
   [void]$shell.Popup($message,35,'LetterFerry - Weixin reconnect',$style)
  }catch{}
 }
}
function Processes(){
 @(Get-CimInstance Win32_Process|Where-Object {
   $_.Name -eq 'node.exe' -and $_.CommandLine -match 'always-on-daemon[.]mjs|start-web-host[.]mjs'
 })
}
function Status([bool]$requireIdle=$false){
 $config=Get-Content -LiteralPath 'data\always-on.json' -Raw -ErrorAction Stop|ConvertFrom-Json
 $processes=Processes
 $daemon=@($processes|Where-Object{$_.CommandLine -match 'always-on-daemon[.]mjs'}).Count -gt 0
 $hostProc=@($processes|Where-Object{$_.CommandLine -match 'start-web-host[.]mjs'}).Count -gt 0
 $hostResponds=$false;$hostState='HOST_OFFLINE'
 try{
  $health=Invoke-RestMethod -Uri 'http://127.0.0.1:8799/health' -TimeoutSec 2
  if($health.ok -eq $true){$hostResponds=$true;$hostState=[string]$health.host}
 }catch{}
 $unresolved=$false
 if($requireIdle){
  & node scripts/check-idle-databases.mjs | Out-Null
  $unresolved=($LASTEXITCODE -ne 0)
 }
 $flags=@(
  ([string]($config.enabled -eq $true)).ToLowerInvariant(),
  ([string]($config.paused -eq $true)).ToLowerInvariant(),
  ([string]$daemon).ToLowerInvariant(),
  ([string]$hostProc).ToLowerInvariant(),
  ([string]$hostResponds).ToLowerInvariant(),
  $hostState,
  ([string]$unresolved).ToLowerInvariant()
 )
 $code=(& node scripts/reconnect-decision.mjs @flags | Select-Object -Last 1)
 if($LASTEXITCODE -ne 0 -or -not $code){throw 'RECONNECT_DECISION_FAILED'}
 return [string]$code
}
try{
 $initial=Status -requireIdle $true
 if($initial -eq 'ALREADY_CONNECTED'){
  Report $initial 'Connected. LetterFerry is online; nothing was restarted.'
  exit 0
 }
 if($initial -eq 'BROWSER_BUSY_OR_WAITING'){
  Report $initial 'Bridge services are running, but the Edge extension heartbeat is not verified. No restart or message replay. Check the exact bound ChatGPT tab, extension receiver version 8 and expected extension manifest v0.4.3; arm only after verifying the tab is idle.'
  exit 0
 }
 if($initial -in @('DISABLED_BY_OWNER','PAUSED_BY_OWNER')){
  Report $initial 'The bridge was intentionally paused or disabled. Use Weixin Resume.cmd in the project folder first. No changes made.' $true
  exit 0
 }
 $decision=Status -requireIdle $true
 if($decision -in @('UNRESOLVED_DELIVERY_REVIEW_REQUIRED','HOST_PROCESS_UNRESPONSIVE','UNRECOGNIZED_LOCAL_HOST_PROCESS','MANUAL_DIAGNOSIS_REQUIRED')){
  Report $decision 'Automatic recovery stopped safely. An unverified task or unexpected Host state requires review. No message was resent.' $true
  exit 1
 }
 if($DryRun){
  Report ('DRY_RUN_'+$decision) 'Read-only diagnosis complete. No process was launched.'
  exit 0
 }
 $mutex=[System.Threading.Mutex]::new($false,'Local\Riven-Weixin-Desktop-Reconnect')
 $owned=$false
 try{
  $owned=$mutex.WaitOne(0)
  if(-not $owned){Report 'ALREADY_RECOVERING' 'A reconnect action is already running.';exit 0}
  # Close the gap between read-only preflight and any new process start.
  $decision=Status -requireIdle $true
  if($decision -eq 'ALREADY_CONNECTED' -or $decision -eq 'BROWSER_BUSY_OR_WAITING'){
   Report $decision 'Connection already running; nothing restarted.'
   exit 0
  }
  if($decision -eq 'START_MISSING_HOST'){
   $node=(Get-Command node.exe -ErrorAction Stop).Source
   $p=Start-Process -FilePath $node -ArgumentList 'scripts/start-web-host.mjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru
   Write-Output 'RECONNECT_ACTION HOST_STARTED'
  }elseif($decision -eq 'START_MISSING_DAEMON'){
   $exe=(Get-Command powershell.exe -ErrorAction Stop).Source
   $boot=Join-Path $root 'scripts\always-on-boot.ps1'
   $p=Start-Process -FilePath $exe -ArgumentList ('-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$boot+'"') -WorkingDirectory $root -WindowStyle Hidden -PassThru
   Write-Output 'RECONNECT_ACTION BOOT_LAUNCHED'
  }else{
   Report $decision 'Recovery not safe or not needed. No process launched.' $true
   exit 1
  }
  Start-Sleep -Seconds 3
  $final=Status -requireIdle $true
  if($final -eq 'ALREADY_CONNECTED'){
   Report 'RESTORED' 'LetterFerry is reconnected. Your ordinary Weixin chat can continue.'
  }elseif($final -eq 'BROWSER_BUSY_OR_WAITING'){
   Report 'RESTORING_BROWSER' 'The local services are running. Wait about 30 seconds for Edge to reconnect. Check ChatGPT login and extension if needed.'
  }else{
   Report ('WAITING_'+$final) 'Reconnect was attempted without re-sending messages. Check Edge and the project status log for a persistent failure.' $true
  }
 }finally{
  if($owned){$mutex.ReleaseMutex()|Out-Null}
  $mutex.Dispose()
 }
}catch{
 Write-Output 'RECONNECT_RESULT SAFE_FAILURE'
 if(-not $Quiet){
  try{(New-Object -ComObject WScript.Shell).Popup('Reconnect was stopped for safety. Please review the project state; no messages were replayed.',35,'LetterFerry - Reconnect',48)|Out-Null}catch{}
 }
 exit 1
}
