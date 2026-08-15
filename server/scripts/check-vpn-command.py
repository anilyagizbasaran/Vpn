#!/usr/bin/env python3
"""Check the `vpn` command that install.sh generates.

    python3 server/scripts/check-vpn-command.py

install.sh writes /usr/local/bin/vpn from a heredoc, so nothing else ever
parses it. A quoting mistake in there ships a server whose only management
command is a syntax error — and `vpn update`, the thing that would fix it,
lives inside the same file.

Extracting and parsing it is the cheapest way to find that before a server
does. Run from the repository root.
"""

import re
import subprocess
import sys
import tempfile
from pathlib import Path

HEREDOC = re.compile(r"cat > /usr/local/bin/vpn <<VPNEOF\n(.*?)\nVPNEOF\n", re.S)

# Every verb the installer's closing message tells the user about. Losing one
# silently is the failure this catches: the message would still advertise it.
REQUIRED = ("howmanydevice", "update")


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    installer = root / "install.sh"
    if not installer.exists():
        print(f"install.sh not found at {installer}", file=sys.stderr)
        return 1

    match = HEREDOC.search(installer.read_text(encoding="utf-8"))
    if not match:
        print("the vpn wrapper heredoc is no longer in install.sh", file=sys.stderr)
        return 1

    # An unquoted heredoc: the installer expands $VAR as it writes the file and
    # passes \$VAR through to the finished script. Reproduce both so what gets
    # parsed here is what lands on the server.
    body = (
        match.group(1)
        .replace("\\$", "$")
        .replace("$INSTALL_DIR", "/opt/vpn")
        .replace("$DOMAIN", "vpn.example.com")
    )

    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False, newline="\n") as handle:
        handle.write(body)
        path = handle.name

    try:
        result = subprocess.run(
            ["sh", "-n", path], capture_output=True, text=True, check=False
        )
    finally:
        Path(path).unlink(missing_ok=True)

    if result.returncode != 0:
        print("the generated vpn command does not parse:", file=sys.stderr)
        print(result.stderr.replace(path, "vpn"), file=sys.stderr)
        return 1

    missing = [verb for verb in REQUIRED if f'"$1" = "{verb}"' not in body]
    if missing:
        print(f"the vpn command no longer handles: {', '.join(missing)}", file=sys.stderr)
        return 1

    print(f"vpn command parses, handling {', '.join(REQUIRED)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
