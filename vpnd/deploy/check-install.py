#!/usr/bin/env python3
"""Check that the Windows installer installs everything the release builds.

    python3 vpnd/deploy/check-install.py

install-windows.ps1 copies binaries by name. A binary added to the release and
not to that list is not a build failure and not a test failure: it installs
cleanly, the daemon works, and one feature is quietly driven by a copy from
whenever the file was last written by hand.

That is not hypothetical. `vpn-browser-host.exe` — the binary the browser
extension talks to, named directly by its native-messaging manifest — was
never in the list. Browser-only mode worked from the app and from vpnctl and
could not be switched on from the extension at all, because the extension was
talking to a build from four weeks earlier.

Run from the repository root.
"""

import re
import sys
from pathlib import Path

# Binaries the release workflow builds, taken from its own loop rather than
# duplicated: a copy here would keep passing after someone edited the workflow.
RELEASE_LOOP = re.compile(r"for cmd in ([a-z0-9 \-]+); do")
RELEASE_EXTRA = re.compile(r"-o \"\.\./dist/([a-z0-9\-]+)\$\{\{ matrix\.ext \}\}\"")

# Names install-windows.ps1 copies beside vpnd.exe.
INSTALLER_LIST = re.compile(r"foreach \(\$name in ((?:'[a-z0-9.\-]+'(?:, )?)+)\)")

# Not installed on purpose. The node agent runs on a server, not a desktop.
NOT_ON_DESKTOP = {"vpn-node-agent"}


def main() -> int:
    root = Path(__file__).resolve().parents[2]

    release = (root / ".github" / "workflows" / "release.yml").read_text(
        encoding="utf-8"
    )
    installer = (root / "vpnd" / "deploy" / "install-windows.ps1").read_text(
        encoding="utf-8"
    )

    loop = RELEASE_LOOP.search(release)
    if not loop:
        print("the release workflow no longer builds binaries in a loop", file=sys.stderr)
        return 1

    built = set(loop.group(1).split()) | set(RELEASE_EXTRA.findall(release))
    built -= NOT_ON_DESKTOP

    listed = INSTALLER_LIST.search(installer)
    if not listed:
        print("install-windows.ps1 no longer copies binaries by name", file=sys.stderr)
        return 1

    # vpnd.exe arrives as -BinaryPath rather than from the list.
    installs = {name.strip("'").removesuffix(".exe") for name in listed.group(1).split(", ")}
    installs.add("vpnd")

    missing = sorted(built - installs)
    if missing:
        print(
            "the release builds these and the Windows installer does not install them:",
            file=sys.stderr,
        )
        for name in missing:
            print(f"  {name}", file=sys.stderr)
        print(
            "\nEach one installs cleanly as an old copy, which is a feature that\n"
            "fails at the button rather than at install time.",
            file=sys.stderr,
        )
        return 1

    stray = sorted(installs - built - {"vpnd"})
    if stray:
        print(
            f"install-windows.ps1 copies binaries the release does not build: {', '.join(stray)}",
            file=sys.stderr,
        )
        return 1

    print(f"the installer installs all {len(built)} released binaries: {', '.join(sorted(built))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
