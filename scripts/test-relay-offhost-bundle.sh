#!/usr/bin/env bash
set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
for role in source destination stranger; do
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$role" \
    -keyout "$work/$role.key" -out "$work/$role.crt" 2>/dev/null
done
printf 'synthetic database checkpoint\n' > "$work/database.sql"
dd if=/dev/urandom of="$work/volume.tar" bs=1M count=16 status=none
run=(python3 scripts/relay-offhost-bundle.py)
"${run[@]}" pack --checkpoint ci-fixture --signer "$work/source.crt" --signing-key "$work/source.key" \
  --recipient "$work/destination.crt" --database "$work/database.sql" --volume "$work/volume.tar" --output "$work/bundle.cms"
restore=("${run[@]}" unpack --recipient "$work/destination.crt" --recipient-key "$work/destination.key")
"${restore[@]}" --checkpoint ci-fixture --signer "$work/source.crt" --bundle "$work/bundle.cms" --output "$work/restored"
cmp "$work/database.sql" "$work/restored/database.sql"
cmp "$work/volume.tar" "$work/restored/volume.tar"
python3 - "$work/bundle.cms" "$work/bad.cms" <<'PYTEST'
from pathlib import Path
import sys
payload = bytearray(Path(sys.argv[1]).read_bytes())
payload[len(payload) // 2] ^= 1
Path(sys.argv[2]).write_bytes(payload)
PYTEST
reject() { if "$@"; then echo 'unexpected restore success' >&2; exit 1; fi; test ! -e "$work/rejected"; }
reject "${restore[@]}" --checkpoint ci-fixture --signer "$work/source.crt" --bundle "$work/bad.cms" --output "$work/rejected"
reject "${restore[@]}" --checkpoint wrong --signer "$work/source.crt" --bundle "$work/bundle.cms" --output "$work/rejected"
reject "${restore[@]}" --checkpoint ci-fixture --signer "$work/stranger.crt" --bundle "$work/bundle.cms" --output "$work/rejected"
echo 'Signed/encrypted checkpoint recovered byte-for-byte; corruption, wrong checkpoint and untrusted signer rejected.'
