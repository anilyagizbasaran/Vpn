<#
.SYNOPSIS
    Installs vpnd as a Windows service. Run from an elevated PowerShell.

.DESCRIPTION
    The service runs as LocalSystem because installing a WireGuard tunnel
    service requires it. The GUI does not: it talks to this service over an
    AF_UNIX socket in ProgramData, whose ACL is set below.

    The socket's ACL is the boundary between an ordinary user and a privileged
    service, so it is granted deliberately and narrowly rather than inherited.

.EXAMPLE
    .\install-windows.ps1 -BinaryPath C:\dev\Vpn\vpnd\bin\vpnd.exe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $BinaryPath,
    [string] $ServiceName = 'vpnd',
    [string] $InstallDir = "$env:ProgramFiles\VpnClient",
    [string] $DataDir = "$env:ProgramData\vpnd",
    # Who may drive the tunnel. Defaults to the interactive user running this
    # script, not the Users group: on a shared machine every account would
    # otherwise be able to turn the VPN on and off.
    [string] $AllowedPrincipal = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell: installing a service needs Administrator.'
}

if (-not (Test-Path $BinaryPath)) { throw "vpnd.exe not found at $BinaryPath" }

Write-Host '==> Checking for WireGuard'
$wireguard = Join-Path $env:ProgramFiles 'WireGuard\wireguard.exe'
if (-not (Test-Path $wireguard)) {
    Write-Warning @'
WireGuard for Windows was not found at the standard location.
vpnd shells out to wireguard.exe to install the tunnel service, so install it
from https://www.wireguard.com/install/ before connecting.
'@
}

# Stopped before the binary is replaced, not after. Windows locks the image of
# a running executable, so copying over it fails, which is what made re-running
# this script to upgrade the daemon die on its third line before anything said
# why.
$running = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($running -and $running.Status -ne 'Stopped') {
    Write-Host '==> Stopping the running service so its binary can be replaced'
    Stop-Service $ServiceName -Force
    $running.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
}

Write-Host '==> Installing the binaries'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = Join-Path $InstallDir 'vpnd.exe'
Copy-Item $BinaryPath $target -Force

# vpnctl travels with the daemon, because the line this script prints at the
# end tells you to run it. Taken from beside the binary given, which is where
# both a go build and the release archive put it.
$vpnctlSource = Join-Path (Split-Path $BinaryPath) 'vpnctl.exe'
if (Test-Path $vpnctlSource) {
    Copy-Item $vpnctlSource (Join-Path $InstallDir 'vpnctl.exe') -Force
    Write-Host '    vpnd.exe, vpnctl.exe'
} else {
    Write-Host '    vpnd.exe only; vpnctl.exe was not next to it'
}

Write-Host '==> Preparing the data directory'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# Replace the inherited ACL rather than adding to it. ProgramData grants
# CreateFiles to Users by default, which would let any account drop a file next
# to the socket and the tunnel config.
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)   # disable inheritance, drop inherited rules

function Add-FullControl([string] $principal) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $principal,
        'FullControl',
        'ContainerInherit,ObjectInherit',
        'None',
        'Allow')
    $acl.AddAccessRule($rule)
}

Add-FullControl 'NT AUTHORITY\SYSTEM'
Add-FullControl 'BUILTIN\Administrators'
# The desktop user needs to open the socket file to talk to the service.
Add-FullControl $AllowedPrincipal
Set-Acl -Path $DataDir -AclObject $acl
Write-Host "    access limited to SYSTEM, Administrators and $AllowedPrincipal"

Write-Host '==> Registering the service'
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host '    service exists, stopping it to replace the binary'
    if ($existing.Status -ne 'Stopped') { Stop-Service $ServiceName -Force }
    # sc.exe delete is asynchronous; wait so the create below does not race it.
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
}

# The path contains a space ("Program Files"), so it needs inner quotes or the
# service manager reads everything after the first space as arguments.
$binPath = '"{0}" --interface vpn0' -f $target

# New-Service rather than `sc.exe create`. sc.exe wants `binPath= <value>` as
# two tokens, and PowerShell's native-argument quoting mangles that into
# something it rejects with 1639 and a page of usage text. New-Service takes
# the same information as parameters and throws on failure instead of
# reporting through an exit code nobody checked.
New-Service -Name $ServiceName `
    -BinaryPathName $binPath `
    -DisplayName 'VPN Client Tunnel Service' `
    -StartupType Automatic `
    -Description 'Creates and removes the WireGuard tunnel for the VPN client. The app talks to this service so it does not have to run as Administrator.' | Out-Null

# Restart on failure rather than leaving the user with a dead service and no
# explanation: 5s, 10s, then every 60s.
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/60000 | Out-Null

Write-Host '==> Starting'
Start-Service $ServiceName
(Get-Service $ServiceName) | Format-Table Name, Status, StartType -AutoSize

Write-Host @"

Installed. Verify with:
    & '$InstallDir\vpnctl.exe' status

To remove:
    Stop-Service $ServiceName; sc.exe delete $ServiceName
"@
