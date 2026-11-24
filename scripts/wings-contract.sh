#!/usr/bin/env bash
set -euo pipefail
# This runs a daemon with access to Docker. Do not use a shared or production host.
[[ "${RELAY_DISPOSABLE_WINGS_CI:-}" == 1 && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${GITHUB_EVENT_NAME:-}" == push ]]
work=$(mktemp -d)
name=relay-wings-contract
harness_pid=''
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [[ -n "$harness_pid" ]]; then kill "$harness_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
curl -fsSL --retry 2 'https://github.com/pterodactyl/wings/releases/download/v1.13.5/wings_linux_amd64' -o "$work/wings"
printf '%s  %s\n' '231134aa6d5aa02aac4f6384b50c76860637858cbc056268b9f96ac42f7f5393' "$work/wings" | sha256sum -c -
chmod 0755 "$work/wings"
export RELAY_WINGS_TEST_TOKEN_ID=relaytestnode
RELAY_WINGS_TEST_TOKEN=$(openssl rand -hex 32)
export RELAY_WINGS_TEST_TOKEN
printf '::add-mask::%s\n' "$RELAY_WINGS_TEST_TOKEN"
mkdir "$work/config"
chmod 0700 "$work/config"
cat > "$work/config/config.yml" <<YAML
uuid: 3ab63670-f83b-4a2c-adeb-5b2852859319
token_id: $RELAY_WINGS_TEST_TOKEN_ID
token: $RELAY_WINGS_TEST_TOKEN
remote: http://127.0.0.1:13200
api:
  host: 127.0.0.1
  port: 18080
  disable_remote_download: true
  ssl:
    enabled: false
system:
  timezone: UTC
  sftp:
    bind_address: 127.0.0.1
    bind_port: 12022
allowed_mounts: []
YAML
chmod 0600 "$work/config/config.yml"
docker pull debian:12-slim
./node_modules/.bin/tsx api/wings/live-contract.ts &
harness_pid=$!
docker run --detach --name "$name" --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$work/wings:/usr/local/bin/wings:ro" \
  -v "$work/config:/etc/pterodactyl" \
  debian:12-slim /usr/local/bin/wings --config /etc/pterodactyl/config.yml >/dev/null
if ! wait "$harness_pid"; then
  state=$(docker inspect --format '{{.State.Status}} (exit {{.State.ExitCode}})' "$name")
  echo "::error::Wings bootstrap did not complete; container $state"
  # Only retain known diagnostic signatures. Do not upload the raw daemon log.
  for signature in 'permission denied' 'iptables' 'address already in use' 'connection refused' 'network' 'mount' 'no such file' 'validation' 'configuration' '403' '401' 'failed to initialize'; do
    if docker logs "$name" 2>&1 | grep -qi "$signature"; then echo "::warning::Daemon log contains diagnostic signature: $signature"; fi
  done
  exit 1
fi
