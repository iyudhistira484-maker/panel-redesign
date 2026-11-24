#!/usr/bin/env bash
set -euo pipefail
# This runs a daemon with access to Docker. Do not use a shared or production host.
[[ "${RELAY_DISPOSABLE_WINGS_CI:-}" == 1 && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${GITHUB_EVENT_NAME:-}" == push ]]
work=$(mktemp -d)
name=relay-wings-contract
network=relay-wings-contract-net
harness_pid=''
remote_port=13200
harness=api/wings/live-contract.ts
if [[ "${RELAY_BOOTSTRAP_SCENARIO:-}" == adoption ]]; then
  remote_port=13202
  harness=api/wings/live-adoption.ts
fi
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [[ -n "$harness_pid" ]]; then kill "$harness_pid" 2>/dev/null || true; fi
  sudo rm -rf -- "$work"
}
trap cleanup EXIT
curl -fsSL --retry 2 'https://github.com/pterodactyl/wings/releases/download/v1.13.5/wings_linux_amd64' -o "$work/wings"
printf '%s  %s\n' '231134aa6d5aa02aac4f6384b50c76860637858cbc056268b9f96ac42f7f5393' "$work/wings" | sha256sum -c -
chmod 0755 "$work/wings"
export RELAY_WINGS_TEST_TOKEN_ID=relaytestnode
RELAY_WINGS_TEST_TOKEN=$(openssl rand -hex 32)
export RELAY_WINGS_TEST_TOKEN
printf '::add-mask::%s\n' "$RELAY_WINGS_TEST_TOKEN"
mkdir "$work/config" "$work/data"
chmod 0700 "$work/config"
cat > "$work/config/config.yml" <<YAML
uuid: 3ab63670-f83b-4a2c-adeb-5b2852859319
token_id: $RELAY_WINGS_TEST_TOKEN_ID
token: $RELAY_WINGS_TEST_TOKEN
remote: http://127.0.0.1:$remote_port
api:
  host: 127.0.0.1
  port: 18080
  disable_remote_download: true
  ssl:
    enabled: false
system:
  root_directory: $work/data
  data: $work/data/volumes
  archive_directory: $work/data/archives
  backup_directory: $work/data/backups
  tmp_directory: $work/data/tmp
  machine_id:
    directory: $work/data/machine-id
  timezone: UTC
  sftp:
    bind_address: 127.0.0.1
    bind_port: 12022
docker:
  network:
    name: $network
    network_mode: $network
allowed_origins:
  - https://relay.example.test
allowed_mounts: []
YAML
chmod 0600 "$work/config/config.yml"
docker pull debian:12-slim
# Docker allocates a subnet distinct from the MySQL service network.
docker network create --internal "$network" >/dev/null
cat <<'DOCKERFILE' | docker build --tag relay-wings-contract-workload:ci -
FROM alpine:3.22.2
ENTRYPOINT ["/bin/sh", "/home/container/relay-start.sh"]
DOCKERFILE
RELAY_ADOPTION_FIXTURE_CONFIG="$work/config/config.yml" ./node_modules/.bin/tsx "$harness" &
harness_pid=$!
docker run --detach --name "$name" --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$work/wings:/usr/local/bin/wings:ro" \
  -v "$work/config:/etc/pterodactyl" \
  -v "$work/data:$work/data" \
  debian:12-slim /usr/local/bin/wings --config /etc/pterodactyl/config.yml >/dev/null
if ! wait "$harness_pid"; then
  state=$(docker inspect --format '{{.State.Status}} (exit {{.State.ExitCode}})' "$name")
  echo "::error::Wings contract did not complete; container $state"
  # Only emit a short fatal diagnostic from this credential-isolated fixture.
  fatal=$(docker logs "$name" 2>&1 | sed -E "s/${RELAY_WINGS_TEST_TOKEN}/[redacted]/g; s/\x1b\[[0-9;]*m//g" | grep -iE 'fatal|error|panic|failed|invalid|configuration' | tail -3 | cut -c1-280 || true)
  while IFS= read -r line; do
    [[ -z "$line" ]] || printf '::warning::%s\n' "$line"
  done <<< "$fatal"
  exit 1
fi
