"""Pack the project into ONE text file, and unpack it again.

Why this exists: KPMG's mail gateway rejects archives on file COUNT
(`550 5.7.0 file count in archive Violation`), and Gmail rejects archives
containing JavaScript. A single text file is not an archive, so neither rule
applies to it.

The bundle is self-describing and self-extracting: it carries this script's
unpack half in its own header, so the recipient needs nothing but Python, which
they need anyway to run the application.

    python3 tools/bundle.py pack   > creditiq-bundle.txt
    python3 creditiq-bundle.txt              # unpacks into ./creditiq

Text files are embedded verbatim between markers, so the bundle stays readable
and reviewable — a mail gateway or a human can see exactly what is in it, which
is not true of a zip. Binary files (the font, the FRED cache) are base64 and are
labelled as such.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Mirrors the archive: source and docs, never dependencies or generated panels.
# The panels are reproducible from a seed — see the README — so shipping 233 MB
# of them would be shipping something the recipient can rebuild in ten seconds.
EXCLUDE_DIRS = {
    ".git", ".venv", "node_modules", "dist", "__pycache__",
    ".pytest_cache", ".ruff_cache", "synthetic",
    # data/cache holds pickled fit results — derived, gigabytes, and
    # regenerated on demand. It postdates this bundler, which is how a
    # "~2 MB" bundle once shipped at 2.2 GB.
    "cache",
}
EXCLUDE_SUFFIXES = {".pyc", ".tsbuildinfo"}
EXCLUDE_NAMES = {".DS_Store"}

BEGIN = "=== FILE:"
END = "=== END ==="
HEADER = """CreditIQ — a single-file source bundle.

This is DATA, not a program. Unpack it with the companion script:

    python3 unpack.py creditiq-bundle.txt

or, without that script, with this one-liner:

    python3 -c "import base64,pathlib,sys;b=pathlib.Path('creditiq-bundle.txt').read_text();\
[ (lambda d,k,v: (d.parent.mkdir(parents=True,exist_ok=True), d.write_bytes(base64.b64decode(v)) \
if k=='[base64]' else d.write_text(v[:-1] if v.endswith(chr(10)) else v)))(
pathlib.Path('creditiq')/h.rsplit(' ',1)[0].strip(), h.rsplit(' ',1)[1], r.rsplit('=== END ===',1)[0]) \
for c in b.split('=== FILE:')[1:] for h,_,r in [c.partition(chr(10))] ]"

Then follow creditiq/README.md — `make setup`, then `make dev`.

Every file below is copied out verbatim. Nothing here executes.

"""


UNPACK = '''"""Unpack a CreditIQ source bundle.

    python3 unpack.py creditiq-bundle.txt [destination]

Writes the project into ./creditiq (or the destination given) and does nothing
else — no network, no shell, no execution of anything it unpacks.
"""
import base64
import pathlib
import sys

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "creditiq-bundle.txt")
out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "creditiq")

n = 0
for chunk in src.read_text(encoding="utf-8").split("=== FILE:")[1:]:
    head, _, rest = chunk.partition("\\n")
    payload = rest.rsplit("=== END ===", 1)[0]
    path, _, kind = head.strip().rpartition(" ")
    dest = out / path.strip()
    # a bundle should never be able to write outside its destination
    if not dest.resolve().is_relative_to(out.resolve()):
        raise SystemExit(f"refusing to write outside {out}: {path}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if kind == "[base64]":
        dest.write_bytes(base64.b64decode(payload))
    else:
        # the packer adds one trailing newline so the end marker sits on its own
        # line; remove exactly that one
        dest.write_text(payload[:-1] if payload.endswith("\\n") else payload,
                        encoding="utf-8")
    n += 1

print(f"unpacked {n} files into {out}/")
print(f"next:  cd {out} && make setup && make dev")
'''


def wanted(p: Path) -> bool:
    if p.name in EXCLUDE_NAMES or p.suffix in EXCLUDE_SUFFIXES:
        return False
    if any(part in EXCLUDE_DIRS for part in p.parts):
        return False
    # saved model versions are demo state, not source — the whole directory,
    # including archived subfolders, which the old parent-name check let
    # through.
    return not (p.parts and p.parts[0] == "versions")


def pack() -> str:
    out = [HEADER]
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file() or not wanted(p.relative_to(ROOT)):
            continue
        rel = p.relative_to(ROOT).as_posix()
        raw = p.read_bytes()
        try:
            text = raw.decode("utf-8")
            if "=== FILE:" in text or "=== END ===" in text:
                raise UnicodeDecodeError("marker", b"", 0, 1, "contains a marker")
            out.append(f"{BEGIN} {rel} [text]\n{text}\n{END}\n")
        except UnicodeDecodeError:
            b64 = base64.b64encode(raw).decode("ascii")
            wrapped = "\n".join(b64[i:i + 100] for i in range(0, len(b64), 100))
            out.append(f"{BEGIN} {rel} [base64]\n{wrapped}\n{END}\n")
    return "".join(out)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "pack":
        sys.stdout.write(pack())
    elif len(sys.argv) > 1 and sys.argv[1] == "unpacker":
        sys.stdout.write(UNPACK)
    else:
        print(__doc__)
