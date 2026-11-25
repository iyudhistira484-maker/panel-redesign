#!/usr/bin/env bash
set -euo pipefail
# This runs a daemon with access to Docker. Do not use a shared or production host.
[[ "${RELAY_DISPOSABLE_WINGS_CI:-}" == 1 && "${RUNNER_ENVIRONMENT:-}" == github-hosted && ( "${GITHUB_EVENT_NAME:-}" == push || ( "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_WORKFLOW:-}" == "Relay Wings off-host staging" ) ) ]]
work=$(mktemp -d)
name=relay-wings-contract
network=relay-wings-contract-net
harness_pid=''
proxy_pid=''
remote_port=13200
harness=api/wings/live-contract.ts
if [[ "${RELAY_BOOTSTRAP_SCENARIO:-}" == adoption || "${RELAY_BOOTSTRAP_SCENARIO:-}" == legacy-panel ]]; then
  remote_port=13202
  harness=api/wings/live-adoption.ts
fi
if [[ "${RELAY_BOOTSTRAP_SCENARIO:-}" == offhost-restore ]]; then
  harness=api/wings/offhost-restore.ts
fi
cleanup() {
  if [[ -n "$proxy_pid" ]]; then kill "$proxy_pid" 2>/dev/null || true; fi
  if [[ "${RELAY_BOOTSTRAP_SCENARIO:-}" == legacy-panel ]]; then docker rm -f relay-adoption-panel relay-adoption-db relay-wings-adoption-second relay-adoption-mailpit >/dev/null 2>&1 || true; fi
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
if [[ "${RELAY_BOOTSTRAP_SCENARIO:-}" == offhost-restore ]]; then
  [[ "$GITHUB_WORKFLOW" == 'Relay Wings off-host staging' && "$GITHUB_EVENT_NAME" == workflow_dispatch ]]
  RELAY_WINGS_TEST_TOKEN=$(jq -er '.node.token | select(test("^[a-f0-9]{64}$"))' "$RELAY_OFFHOST_RUNTIME")
fi
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
  - https://127.0.0.1:4443
allowed_mounts: []
YAML
if [[ "${RELAY_BOOTSTRAP_SCENARIO:-}" == offhost-restore ]]; then
  mkdir "$work/data/volumes"
  sudo tar --numeric-owner -xf "$RELAY_OFFHOST_VOLUME" -C "$work/data/volumes"
fi
chmod 0600 "$work/config/config.yml"
docker pull debian:12-slim
# Docker allocates a subnet distinct from the MySQL service network.
if [[ "${RELAY_BOOTSTRAP_SCENARIO:-}" == gitea-qualification ]]; then
  # This upstream installer downloads a release over HTTPS; allocations remain loopback-only.
  docker network create "$network" >/dev/null
else
  docker network create --internal "$network" >/dev/null
fi
cat <<'DOCKERFILE' | docker build --tag relay-wings-contract-workload:ci -
FROM alpine:3.22.2
ENTRYPOINT ["/bin/sh", "/home/container/relay-start.sh"]
DOCKERFILE
if [[ "$harness" == api/wings/live-contract.ts ]]; then
  cat <<'DOCKERFILE' | docker build --tag relay-wings-contract-http:ci -
FROM alpine:3.22.2
RUN apk add --no-cache busybox-extras
ENTRYPOINT ["/bin/sh", "-c", "exec /bin/sh -c \"$STARTUP\""]
DOCKERFILE
fi
if [[ "${RELAY_BOOTSTRAP_SCENARIO:-}" == legacy-panel ]]; then
  export RELAY_SECOND_NODE_TOKEN_ID=relaysecondnode
  RELAY_SECOND_NODE_TOKEN=$(openssl rand -hex 32)
  export RELAY_SECOND_NODE_TOKEN
  printf '::add-mask::%s\n' "$RELAY_SECOND_NODE_TOKEN"
  mkdir -m 0700 "$work/config2" "$work/data2"
  sed -e 's/3ab63670-f83b-4a2c-adeb-5b2852859319/33113cc5-78fb-4cd0-881b-326c3888b38b/' \
    -e "s/$RELAY_WINGS_TEST_TOKEN_ID/$RELAY_SECOND_NODE_TOKEN_ID/; s/$RELAY_WINGS_TEST_TOKEN/$RELAY_SECOND_NODE_TOKEN/" \
    -e 's|/data\b|/data2|g; s/18080/18081/; s/12022/12023/' "$work/config/config.yml" > "$work/config2/config.yml"
  chmod 0600 "$work/config2/config.yml"
  docker run -d --name relay-adoption-mailpit -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 axllent/mailpit:v1.27.11 >/dev/null
  for key in SERVER EGG OWNER NEST SECOND SECOND_EGG COLLABORATOR OUTSIDER; do
    export "RELAY_ADOPTION_${key}_UUID=$(cat /proc/sys/kernel/random/uuid)"
  done
  db_password=$(openssl rand -hex 24)
  snapshot_password=$(openssl rand -hex 24)
  export RELAY_LEGACY_SNAPSHOT_URL="mysql://relay_snapshot:$snapshot_password@127.0.0.1:13306/panel_snapshot_ci"
  export RELAY_LEGACY_SNAPSHOT_CI_PASSWORD="$db_password"
  export RELAY_LEGACY_SNAPSHOT_READER_PASSWORD="$snapshot_password"
  app_key="base64:$(openssl rand -base64 32)"
  printf '::add-mask::%s\n' "$db_password" "$app_key" "$snapshot_password"
  docker run -d --name relay-adoption-db -p 127.0.0.1:13306:3306 \
    -e MYSQL_ROOT_PASSWORD="$db_password" -e MYSQL_DATABASE=panel_adoption_fixture \
    -e MYSQL_USER=panel_fixture -e MYSQL_PASSWORD="$db_password" mariadb:10.11 >/dev/null
  for i in {1..45}; do
    if docker exec relay-adoption-db healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec relay-adoption-db healthcheck.sh --connect --innodb_initialized >/dev/null
  docker run -d --name relay-adoption-panel --network host --entrypoint /bin/ash \
    -v "$PWD/scripts/legacy-adoption-fixture.php:/tmp/relay-fixture.php:ro" \
    -e APP_ENV=production -e APP_KEY="$app_key" -e APP_URL=http://127.0.0.1:13202 \
    -e PHP_CLI_SERVER_WORKERS=4 -e APP_DEBUG=false -e DB_CONNECTION=mysql -e DB_HOST=127.0.0.1 -e DB_PORT=13306 -e DB_DATABASE=panel_adoption_fixture \
    -e DB_USERNAME=panel_fixture -e DB_PASSWORD="$db_password" \
    -e CACHE_DRIVER=file -e SESSION_DRIVER=file -e QUEUE_CONNECTION=sync \
    -e PTERODACTYL_SEND_INSTALL_NOTIFICATION=false -e PTERODACTYL_SEND_REINSTALL_NOTIFICATION=false -e RELAY_LEGACY_FIXTURE=1 \
    -e RELAY_WINGS_TEST_TOKEN -e RELAY_WINGS_TEST_TOKEN_ID -e RELAY_SECOND_NODE_TOKEN -e RELAY_SECOND_NODE_TOKEN_ID \
    -e RELAY_ADOPTION_SERVER_UUID -e RELAY_ADOPTION_EGG_UUID -e RELAY_ADOPTION_OWNER_UUID -e RELAY_ADOPTION_NEST_UUID -e RELAY_ADOPTION_SECOND_UUID -e RELAY_ADOPTION_SECOND_EGG_UUID \
    -e RELAY_ADOPTION_COLLABORATOR_UUID -e RELAY_ADOPTION_OUTSIDER_UUID \
    ghcr.io/pterodactyl/panel:v1.15.2 -ec 'cd /app; printf "[client]\nskip-ssl\n" > /root/.my.cnf; php artisan migrate --force; php /tmp/relay-fixture.php; exec php -S 127.0.0.1:13202 -t public' >/dev/null
  for i in {1..45}; do
    if curl -s -o /dev/null http://127.0.0.1:13202/api/remote/servers; then break; fi
    if [[ $(docker inspect -f '{{.State.Running}}' relay-adoption-panel) != true ]]; then break; fi
    sleep 1
  done
  if ! curl -s -o /dev/null http://127.0.0.1:13202/api/remote/servers; then
    echo '::error::Legacy Panel fixture did not start'
    diagnostics=$(docker logs relay-adoption-panel 2>&1 | sed -E "s/$db_password|$RELAY_WINGS_TEST_TOKEN/[redacted]/g" | grep -Ei 'error|exception|fatal|failed|not found|denied|SQLSTATE' | tail -5 | cut -c1-230 || true)
    while IFS= read -r message; do [[ -z "$message" ]] || printf '::warning::%s\n' "$message"; done <<< "$diagnostics"
    exit 1
  fi
fi
if [[ "${RELAY_BOOTSTRAP_SCENARIO:-}" == legacy-panel ]]; then
  export RELAY_WINGS_BROWSER=1
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -addext 'subjectAltName=IP:127.0.0.1' -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
  node scripts/auth-browser-proxy.mjs "$work/cert.pem" "$work/key.pem" 13200 &
  proxy_pid=$!
fi
RELAY_WINGS_CONTRACT_DATA="$work/data/volumes" RELAY_ADOPTION_FIXTURE_CONFIG="$work/config/config.yml" RELAY_ADOPTION_SECOND_CONFIG="$work/config2/config.yml" ./node_modules/.bin/tsx "$harness" &
harness_pid=$!
docker run --detach --name "$name" --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$work/wings:/usr/local/bin/wings:ro" \
  -v "$work/config:/etc/pterodactyl" \
  -v "$work/data:$work/data" \
  debian:12-slim /usr/local/bin/wings --config /etc/pterodactyl/config.yml >/dev/null
if [[ "${RELAY_BOOTSTRAP_SCENARIO:-}" == legacy-panel ]]; then
  docker run -d --name relay-wings-adoption-second --network host \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$work/wings:/usr/local/bin/wings:ro" \
    -v "$work/config2:/etc/pterodactyl" -v "$work/data2:$work/data2" \
    debian:12-slim /usr/local/bin/wings --config /etc/pterodactyl/config.yml >/dev/null
fi
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
