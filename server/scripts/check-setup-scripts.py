#!/usr/bin/env python3
"""Check the shell scripts that configure a VPN server.

    python3 server/scripts/check-setup-scripts.py

setup-wg.sh and setup-ikev2.sh run once, as root, on somebody's server. A
mistake in either is discovered by that person, at the worst moment, with the
service half configured — so what can be checked without a server is checked
here. Run from the repository root.

Two things are verified:

1. Both scripts parse. They are only ever executed on a fresh machine, so a
   syntax error ships and is found there.

2. setup-ikev2.sh detects the server key type correctly. This is not a
   hypothetical: the first version tested the wrong line of `openssl pkey`
   output and concluded RSA for every key, including the ECDSA one Let's
   Encrypt issues by default. strongSwan then loaded no key at all and every
   phone failed authentication after a handshake that looked healthy — the
   error message names none of that. The detection line is extracted from the
   script and run against real keys, so the test exercises the shipped logic
   rather than a copy of it.
"""

import re
import subprocess
import sys
import tempfile
from pathlib import Path

# The line in setup-ikev2.sh that decides RSA vs ECDSA. Matched rather than
# duplicated: a copy here would keep passing after someone edited the script.
DETECT = re.compile(r"^if (openssl pkey -in .*? \| grep -qi '.*?'); then$", re.M)


def run(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, capture_output=True, text=True, input=stdin, check=False
    )


def scripts_parse(root: Path) -> list[str]:
    """`bash -n` over every setup script. Returns failures."""
    problems = []
    for name in ("setup-wg.sh", "setup-ikev2.sh"):
        path = root / "server" / "scripts" / name
        if not path.exists():
            problems.append(f"{name} is missing")
            continue
        result = run("bash", "-n", str(path))
        if result.returncode != 0:
            problems.append(f"{name} does not parse:\n{result.stderr.strip()}")
    return problems


def make_key(kind: str, path: Path) -> bool:
    """Writes a PKCS#8 private key of the given kind, as certbot would."""
    if kind == "ecdsa":
        gen = run("openssl", "ecparam", "-genkey", "-name", "prime256v1", "-noout")
    else:
        gen = run("openssl", "genrsa", "2048")
    if gen.returncode != 0:
        return False

    # Certbot writes PKCS#8 ("BEGIN PRIVATE KEY"), which is the format whose
    # header says nothing about the key type — the reason the first detection
    # attempt failed.
    pkcs8 = run("openssl", "pkcs8", "-topk8", "-nocrypt", stdin=gen.stdout)
    if pkcs8.returncode != 0:
        return False

    path.write_text(pkcs8.stdout)
    return True


def key_detection(root: Path) -> list[str]:
    source = (root / "server" / "scripts" / "setup-ikev2.sh").read_text(
        encoding="utf-8"
    )
    match = DETECT.search(source)
    if not match:
        return ["the key-type detection line is no longer in setup-ikev2.sh"]

    condition = match.group(1)
    problems = []

    with tempfile.TemporaryDirectory() as tmp:
        for kind, expected in (("ecdsa", "ECDSA"), ("rsa", "RSA")):
            key = Path(tmp) / f"{kind}.pem"
            if not make_key(kind, key):
                problems.append(f"could not generate a {kind} key to test with")
                continue

            # The script's own condition, with its path substituted. Anything
            # else would be testing a transcription.
            probe = condition.replace('"$LIVE/privkey.pem"', f'"{key}"')
            result = run("bash", "-c", f"if {probe}; then echo ECDSA; else echo RSA; fi")
            got = result.stdout.strip()

            if got != expected:
                problems.append(
                    f"a {kind} key was read as {got}; strongSwan would load no "
                    f"key and every phone would fail authentication"
                )

    return problems


def main() -> int:
    root = Path(__file__).resolve().parents[2]

    problems = scripts_parse(root) + key_detection(root)
    if problems:
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    print("setup scripts parse; server key type is detected for RSA and ECDSA")
    return 0


if __name__ == "__main__":
    sys.exit(main())
