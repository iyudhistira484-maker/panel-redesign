#!/usr/bin/env bash
set -euo pipefail
# Staging adapter for the exact, hash-reviewed Gitea egg. Do not resolve latest.
version=1.25.5
[[ "${VERSION:-}" == "$version" ]]
case "$(uname -m)" in
  x86_64) arch=amd64; sha=1c86b689cd44f843299cb12b5b3eb1189d0638d5ffda04eb6b4dd0fe395422fc ;;
  aarch64) arch=arm64; sha=371e29efea7d0fa7851aee5512869a9c8690b2d17e7486696465b9e26cd5b1d8 ;;
  *) echo 'Unsupported Gitea architecture' >&2; exit 1 ;;
esac
cd /mnt/server
artifact=$(mktemp .gitea-download.XXXXXXXX)
trap 'rm -f -- "$artifact"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --retry 3 --retry-all-errors --connect-timeout 10 --max-time 90 \
  -o "$artifact" "https://github.com/go-gitea/gitea/releases/download/v${version}/gitea-${version}-linux-${arch}"
printf '%s  %s\n' "$sha" "$artifact" | sha256sum --check --status
chmod 0755 "$artifact"
mv -fT -- "$artifact" gitea
mkdir -p custom
if [[ ! -f custom/app.ini ]]; then
  cat > custom/app.ini <<CONFIG
[server]
LOCAL_ROOT_URL = http://${SERVER_IP}:${SERVER_PORT}/
DOMAIN = ${SERVER_IP}
HTTP_PORT = ${SERVER_PORT}
ROOT_URL = http://${SERVER_IP}:${SERVER_PORT}/
DISABLE_SSH = ${DISABLE_SSH}
SSH_PORT = ${SSH_PORT}
CONFIG
fi
