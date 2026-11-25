#!/usr/bin/env python3
"""Package trusted staging checkpoints; does not run SQL or extract volume contents."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

FILES = ("database.sql", "volume.tar")
LIMIT = 512 * 1024 * 1024


def openssl(*args):
    subprocess.run(["openssl", "cms", "-binary", *map(str, args)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def fingerprint(path):
    with path.open("rb") as stream:
        return {"size": path.stat().st_size,
                "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}


def pack(args):
    if args.output.exists() or args.output.is_symlink():
        raise ValueError("output already exists")
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        inputs = dict(zip(FILES, (args.database, args.volume)))
        if any(not p.is_file() or p.is_symlink() for p in inputs.values()):
            raise ValueError("inputs must be regular files")
        if not all(0 < p.stat().st_size <= LIMIT for p in inputs.values()):
            raise ValueError("input outside bundle size limits")
        manifest = base / "manifest.json"
        manifest.write_text(json.dumps({"version": 1, "checkpoint": args.checkpoint,
                                        "files": {n: fingerprint(p) for n, p in inputs.items()}}))
        archive, signed, encrypted = (base / name for name in ("archive", "signed", "encrypted"))
        with tarfile.open(archive, "w") as tar:
            tar.add(manifest, arcname="manifest.json", recursive=False)
            for name, path in inputs.items():
                tar.add(path, arcname=name, recursive=False)
        openssl("-sign", "-nodetach", "-md", "sha256", "-in", archive, "-outform", "DER",
                "-out", signed, "-signer", args.signer, "-inkey", args.signing_key)
        openssl("-encrypt", "-aes-256-gcm", "-in", signed, "-outform", "DER", "-out", encrypted, args.recipient)
        with args.output.open("xb") as output, encrypted.open("rb") as source:
            shutil.copyfileobj(source, output)


def unpack(args):
    if args.output.exists() or args.output.is_symlink():
        raise ValueError("restore destination already exists")
    if args.bundle.is_symlink() or not args.bundle.is_file() or args.bundle.stat().st_size > 2 * LIMIT + 65536:
        raise ValueError("invalid bundle")
    with tempfile.TemporaryDirectory(dir=args.output.parent) as tmp:
        base = Path(tmp)
        signed, archive = base / "signed", base / "archive"
        openssl("-decrypt", "-inform", "DER", "-in", args.bundle, "-recip", args.recipient,
                "-inkey", args.recipient_key, "-out", signed)
        # Trust the explicitly pinned signer, never a certificate supplied by the bundle.
        openssl("-verify", "-inform", "DER", "-in", signed, "-nointern", "-noverify",
                "-certfile", args.signer, "-out", archive)
        staged = base / "verified"
        staged.mkdir(mode=0o700)
        with tarfile.open(archive, "r:") as tar:
            expected = {"manifest.json", *FILES}
            for item in tar:
                if item.name not in expected or not item.isfile() or not 0 < item.size <= (4096 if item.name == "manifest.json" else LIMIT):
                    raise ValueError("unexpected archive entry")
                expected.remove(item.name)
                with tar.extractfile(item) as source, (staged / item.name).open("xb") as output:
                    shutil.copyfileobj(source, output)
            if expected:
                raise ValueError("incomplete archive")
        manifest = json.loads((staged / "manifest.json").read_text())
        if manifest != {"version": 1, "checkpoint": args.checkpoint,
                        "files": {n: fingerprint(staged / n) for n in FILES}}:
            raise ValueError("checkpoint manifest mismatch")
        # Stage and publish atomically on the same filesystem. The operator must
        # use a private parent directory with no concurrent writers.
        if args.output.exists() or args.output.is_symlink():
            raise ValueError("restore destination already exists")
        staged.rename(args.output)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("pack", "unpack"):
        command = commands.add_parser(name)
        command.add_argument("--checkpoint", required=True)
        for path in ("output", "signer", "recipient", *(
                ("database", "volume", "signing-key") if name == "pack" else ("bundle", "recipient-key"))):
            command.add_argument(f"--{path}", required=True, type=Path)
    args = parser.parse_args()
    if not args.checkpoint or len(args.checkpoint) > 128:
        parser.error("invalid checkpoint")
    try:
        (pack if args.command == "pack" else unpack)(args)
    except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError):
        sys.exit("Checkpoint rejected; no verified restore published")


if __name__ == "__main__":
    main()
