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

Write-Host '==> Installing the binary'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = Join-Path $InstallDir 'vpnd.exe'
Copy-Item $BinaryPath $target -Force

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

& sc.exe create $ServiceName `
    binPath= "`"$target`" --interface vpn0" `
    start= auto `
    DisplayName= 'VPN Client Tunnel Service' | Out-Null
& sc.exe description $ServiceName `
    'Creates and removes the WireGuard tunnel for the VPN client. The app talks to this service so it does not have to run as Administrator.' | Out-Null

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
