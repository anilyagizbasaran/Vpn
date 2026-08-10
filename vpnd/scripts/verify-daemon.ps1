<#
.SYNOPSIS
    Checks the vpnd Windows service after installing it.

.DESCRIPTION
    The GUI reports "The VPN service is not running" for every failure mode
    here, which is right for a user and useless for diagnosis. This tells them
    apart: service stopped, socket ACL wrong, WireGuard missing, protocol
    mismatch after a partial upgrade.

.EXAMPLE
    .\verify-daemon.ps1 -Vpnctl 'C:\Program Files\VpnClient\vpnctl.exe'
#>
[CmdletBinding()]
param(
    [string] $ServiceName = 'vpnd',
    [string] $Socket = "$env:ProgramData\vpnd\vpnd.sock",
    [string] $Vpnctl = "$env:ProgramFiles\VpnClient\vpnctl.exe",
    [int] $ExpectedProtocol = 1
)

$script:Pass = 0; $script:Fail = 0; $script:Warn = 0

function Section($text) { Write-Host "`n$text" -ForegroundColor White }
function Pass($text) { Write-Host "  PASS " -ForegroundColor Green -NoNewline; Write-Host $text; $script:Pass++ }
function Fail($text, $hint) {
    Write-Host "  FAIL " -ForegroundColor Red -NoNewline; Write-Host $text
    if ($hint) { Write-Host "       $hint" -ForegroundColor DarkGray }
    $script:Fail++
}
function Warn($text, $hint) {
    Write-Host "  WARN " -ForegroundColor Yellow -NoNewline; Write-Host $text
    if ($hint) { Write-Host "       $hint" -ForegroundColor DarkGray }
    $script:Warn++
}

Section 'Service'

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
    Fail "the $ServiceName service is not installed" 'run deploy\install-windows.ps1 from an elevated shell'
} elseif ($service.Status -eq 'Running') {
    Pass "$ServiceName is running"
    if ($service.StartType -eq 'Automatic') {
        Pass 'it starts on boot'
    } else {
        Warn "start type is $($service.StartType)" 'it will not come back after a reboot'
    }
} else {
    Fail "$ServiceName is $($service.Status)" "Start-Service $ServiceName, then check Event Viewer"
}

Section 'Socket'

if (Test-Path $Socket) {
    Pass "the socket exists at $Socket"

    # The ACL is the boundary between an ordinary user and a privileged
    # service, so an inherited one is a finding rather than a detail.
    $acl = Get-Acl (Split-Path $Socket -Parent)
    if ($acl.AreAccessRulesProtected) {
        Pass 'the data directory does not inherit permissions'
    } else {
        Fail 'the data directory inherits its ACL' 'ProgramData grants CreateFiles to Users by default'
    }

    $broad = $acl.Access | Where-Object {
        $_.IdentityReference -match 'Everyone|BUILTIN\\Users|Authenticated Users'
    }
    if ($broad) {
        Warn 'a broad principal has access to the data directory' ($broad | ForEach-Object { $_.IdentityReference } | Join-String -Separator ', ')
    } else {
        Pass 'no broad principals in the ACL'
    }
} else {
    Fail "no socket at $Socket" 'the service is not running, or it was started with a different -socket'
}

# AF_UNIX only. A loopback TCP listener is reachable by every process on the
# machine and by a web page.
$tcp = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'vpnd' }
if ($tcp) {
    Fail 'vpnd is listening on TCP' 'this is the Tailscale local-API vulnerability class; it must use AF_UNIX only'
} else {
    Pass 'vpnd is not listening on any TCP port'
}

Section 'Protocol'

if (-not (Test-Path $Vpnctl)) {
    Warn 'vpnctl not found' "pass -Vpnctl with its path to run the protocol checks"
} else {
    $version = & $Vpnctl -socket $Socket version 2>&1 | Out-String
    if ($version -match '"ok":\s*true') {
        Pass 'the daemon answers a version request'
        if ($version -match '"protocol":\s*(\d+)') {
            $protocol = [int]$Matches[1]
            if ($protocol -eq $ExpectedProtocol) {
                Pass "protocol version $protocol matches the app"
            } else {
                Fail "protocol version $protocol, app expects $ExpectedProtocol" 'a partial upgrade left an old service behind'
            }
        }
    } else {
        Fail 'the daemon did not answer' $version.Trim()
    }

    # The control that stops a local user turning the daemon into SYSTEM.
    $hostile = Join-Path $env:TEMP 'vpnd-hostile.conf'
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($hostile, @"
[Interface]
PrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHJpdmE=
Address = 10.8.0.5/32
PostUp = cmd.exe /c echo pwned > C:\vpnd-pwned.txt

[Peer]
PublicKey = c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=
AllowedIPs = 0.0.0.0/0
"@, $utf8)

    Remove-Item 'C:\vpnd-pwned.txt' -ErrorAction SilentlyContinue
    $result = & $Vpnctl -socket $Socket -config $hostile up 2>&1 | Out-String

    if (Test-Path 'C:\vpnd-pwned.txt') {
        Fail 'a PostUp hook EXECUTED' 'this is arbitrary code execution as SYSTEM — stop the service now'
        Remove-Item 'C:\vpnd-pwned.txt' -ErrorAction SilentlyContinue
    } elseif ($result -match '"ok":\s*false') {
        Pass 'a config with a PostUp hook is rejected'
    } else {
        Fail 'a config with a PostUp hook was accepted' $result.Trim()
    }
    Remove-Item $hostile -ErrorAction SilentlyContinue
}

Section 'WireGuard tooling'

$wireguard = Join-Path $env:ProgramFiles 'WireGuard\wireguard.exe'
if (Test-Path $wireguard) {
    Pass 'WireGuard for Windows is installed'
} else {
    Fail 'wireguard.exe not found' 'the daemon shells out to it: https://www.wireguard.com/install/'
}

Write-Host "`nSummary" -ForegroundColor White
Write-Host "  $script:Pass passed" -ForegroundColor Green -NoNewline
Write-Host "  $script:Fail failed" -NoNewline
Write-Host "  $script:Warn warnings" -ForegroundColor Yellow

if ($script:Fail -gt 0) { exit 1 }
exit 0
