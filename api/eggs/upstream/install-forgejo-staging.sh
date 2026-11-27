#!/bin/sh
set -eu
# Use the versioned official image rather than downloading a web release in Wings.
case "${VERSION:-}" in 11.0.5) ;; *) exit 1 ;; esac
binary=
# The image's forgejo command can be a wrapper; copy the executable itself.
for candidate in /app/gitea/gitea /app/forgejo/forgejo /usr/local/bin/gitea /usr/local/bin/forgejo /usr/bin/forgejo /usr/bin/gitea; do
  [ -x "$candidate" ] || continue
  [ "$(od -An -tx1 -N4 "$candidate" | tr -d ' \n')" = 7f454c46 ] || continue
  if "$candidate" --version | grep -E 'Forgejo version 11\.0\.5([ +]|$)'; then
    binary=$candidate
    break
  fi
done
[ -n "$binary" ] || { echo 'Forgejo 11.0.5 ELF executable not found' >&2; exit 1; }
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
