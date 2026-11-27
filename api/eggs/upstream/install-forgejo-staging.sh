#!/bin/sh
set -eu
# Use the versioned official image rather than downloading a web release in Wings.
case "${VERSION:-}" in 11.0.5) ;; *) exit 1 ;; esac
binary=$(command -v forgejo || command -v gitea)
"$binary" --version | grep -E 'Forgejo version 11\.0\.5([ +]|$)'
cd /mnt/server
artifact=$(mktemp .forgejo-install.XXXXXXXX)
trap 'rm -f -- "$artifact"' EXIT
cp "$binary" "$artifact"
chmod 0755 "$artifact"
mv -fT -- "$artifact" forgejo
mkdir -p custom
if [ ! -f custom/app.ini ]; then
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
