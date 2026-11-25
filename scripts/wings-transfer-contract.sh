#!/usr/bin/env bash
set -euo pipefail
[[ "${RELAY_DISPOSABLE_WINGS_CI:-}" == 1 && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${GITHUB_EVENT_NAME:-}" == push ]]
work=$(mktemp -d)
src=relay-transfer-source
dst=relay-transfer-target
engine=relay-transfer-engine
net=relay-transfer-workloads
pid=''
cleanup() {
  docker rm -f "$src" "$dst" "$engine" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  sudo rm -rf -- "$work"
}
trap cleanup EXIT
curl -fsSL --retry 2 'https://github.com/pterodactyl/wings/releases/download/v1.13.5/wings_linux_amd64' -o "$work/wings"
printf '%s  %s\n' '231134aa6d5aa02aac4f6384b50c76860637858cbc056268b9f96ac42f7f5393' "$work/wings" | sha256sum -c -
chmod 0755 "$work/wings"
# Use the pinned official sender and a locally built destination candidate.
patch="$PWD/patches/wings/v1.13.5-transfer-checksum.patch"
go test "$PWD/patches/wings/checksum_test.go"
git clone --quiet --depth 1 --branch v1.13.5 https://github.com/pterodactyl/wings.git "$work/wings-source"
[[ "$(git -C "$work/wings-source" rev-parse HEAD)" == 3236480d078c09b823b8a8f21dab76c4029608a5 ]]
git -C "$work/wings-source" apply --check "$patch"
git -C "$work/wings-source" apply "$patch"
(cd "$work/wings-source" && CGO_ENABLED=0 go build -trimpath -ldflags="-X github.com/pterodactyl/wings/system.Version=1.13.5" -o "$work/wings-target" ./wings.go)
RELAY_TRANSFER_SOURCE_TOKEN=$(openssl rand -hex 32)
RELAY_TRANSFER_TARGET_TOKEN=$(openssl rand -hex 32)
export RELAY_TRANSFER_SOURCE_TOKEN RELAY_TRANSFER_TARGET_TOKEN
printf '::add-mask::%s\n' "$RELAY_TRANSFER_SOURCE_TOKEN" "$RELAY_TRANSFER_TARGET_TOKEN"
mkdir "$work/engine" "$work/source-data" "$work/target-data" "$work/source-config" "$work/target-config"
write_config() {
  local side=$1 token=$2 port=$3 sftp=$4 uuid=$5
  local remote="http://127.0.0.1:13201/$side"
  if [[ "$side" == target && "${RELAY_TRANSFER_SCENARIO:-reported}" == *reported ]]; then remote=http://127.0.0.1:13202; fi
  cat > "$work/$side-config/config.yml" <<YAML
uuid: $uuid
token_id: relaytransfer$side
token: $token
remote: $remote
api:
  host: 127.0.0.1
  port: $port
  disable_remote_download: true
  ssl:
    enabled: false
system:
  root_directory: $work/$side-data
  data: $work/$side-data/volumes
  archive_directory: $work/$side-data/archives
  backup_directory: $work/$side-data/backups
  tmp_directory: $work/$side-data/tmp
  machine_id:
    directory: $work/$side-data/machine-id
  timezone: UTC
  sftp:
    bind_address: 127.0.0.1
    bind_port: $sftp
docker:
  network:
    name: $net
    network_mode: $net
    dns: []
allowed_mounts: []
YAML
  chmod 0600 "$work/$side-config/config.yml"
}
write_config source "$RELAY_TRANSFER_SOURCE_TOKEN" 18180 12122 '4192d1ec-21d8-4082-b86c-0771b74678ff'
write_config target "$RELAY_TRANSFER_TARGET_TOKEN" 18181 12123 '33113cc5-78fb-4cd0-881b-326c3888b38b'
# Inner daemon has a private socket, so source and destination can each own the same server UUID.
docker run -d --privileged --cgroupns=host --name "$engine" \
  -v "$work/engine:/relay-engine" -v "$work/target-data:$work/target-data" \
  --entrypoint dockerd docker:28.5.2-dind \
  --host unix:///relay-engine/docker.sock --storage-driver=vfs --exec-opt native.cgroupdriver=cgroupfs --cgroup-parent=/relay-transfer-ci --bip=172.26.10.1/24 >/dev/null
inner="unix://$work/engine/docker.sock"
for i in {1..30}; do if sudo -n docker -H "$inner" info >/dev/null 2>&1; then break; fi; sleep 1; done
if ! sudo -n docker -H "$inner" info >/dev/null 2>&1; then
  echo '::error::Disposable destination Docker engine did not become ready'
  diagnostics=$(docker logs "$engine" 2>&1 | grep -Ei 'fatal|failed|error' | tail -4 | cut -c1-260 || true)
  while IFS= read -r message; do [[ -z "$message" ]] || printf '::warning::%s\n' "$message"; done <<< "$diagnostics"
  exit 1
fi
docker pull debian:12-slim >/dev/null
if [[ "${RELAY_TRANSFER_SCENARIO:-}" == mumble-* ]]; then
  # Upstream installer needs Alpine repositories; destination never runs the installer.
  docker network create "$net" >/dev/null
else
  docker network create --internal "$net" >/dev/null
fi
sudo -n docker -H "$inner" network create --internal "$net" >/dev/null
# Copy a pinned fixture image into the destination engine rather than sharing a runtime container.
cat <<'DOCKERFILE' | docker build --tag relay-wings-contract-http:ci - >/dev/null
FROM alpine:3.22.2
RUN apk add --no-cache busybox-extras
ENTRYPOINT ["/bin/sh", "-c", "exec /bin/sh -c \"$STARTUP\""]
DOCKERFILE
docker save relay-wings-contract-http:ci | sudo -n docker -H "$inner" load >/dev/null
if [[ "${RELAY_TRANSFER_SCENARIO:-}" == mumble-* ]]; then
  # Model an existing Mumble server. The unchanged upstream installer intentionally
  # preserves an existing INI, so transfer verification does not depend on APK DNS.
  export RELAY_MUMBLE_TRANSFER_UUID=$(cat /proc/sys/kernel/random/uuid)
  seed="$work/source-data/volumes/$RELAY_MUMBLE_TRANSFER_UUID"
  mkdir -p "$seed"
  cat > "$seed/murmur.ini" <<'INI'
database=/home/container/murmur.sqlite
logfile=/home/container/murmur.log
port=25610
host=0.0.0.0
users=37
INI
  image=ghcr.io/parkervcp/yolks:voice_mumble
  docker pull "$image" >/dev/null
  docker save "$image" | sudo -n docker -H "$inner" load >/dev/null
fi
RELAY_TRANSFER_CHECK_DESTINATION_RUNTIME=1 RELAY_TRANSFER_SOURCE_ROOT="$work/source-data" RELAY_TRANSFER_FIXTURE_ROOT="$work/target-data" ./node_modules/.bin/tsx api/wings/live-transfer.ts &
pid=$!
run_wings() {
  local role=$1 name=$2 socket=$3 binary="$work/wings"
  if [[ "$role" == target ]]; then binary="$work/wings-target"; fi
  docker run --detach --name "$name" --network host \
    -v "$socket:/var/run/docker.sock" \
    -v "$binary:/usr/local/bin/wings:ro" \
    -v "$work/$role-config:/etc/pterodactyl" \
    -v "$work/$role-data:$work/$role-data" \
    debian:12-slim /usr/local/bin/wings --config /etc/pterodactyl/config.yml >/dev/null
}
run_wings source "$src" /var/run/docker.sock
run_wings target "$dst" "$work/engine/docker.sock"
if ! wait "$pid"; then
  if [[ "${RELAY_TRANSFER_SCENARIO:-}" == mumble-* ]]; then
    # Export only fixed diagnostic labels; Wings installer logs also contain environment values.
    install_log=$(docker exec "$src" /bin/sh -c 'cat /var/log/pterodactyl/install/*.log' 2>/dev/null || true)
    for marker in 'DNS' 'temporary error' 'no such package' 'Permission denied' 'No such file' 'SSL' 'Downloading the config file' 'Config file already exists' 'murmur-'; do
      if grep -qiF "$marker" <<< "$install_log"; then printf '::warning::Mumble installer marker: %s\n' "$marker"; fi
    done
  fi
  for name in "$src" "$dst"; do
    docker inspect --format '{{.Name}}: {{.State.Status}} (exit {{.State.ExitCode}})' "$name"
    diagnostics=$(docker logs "$name" 2>&1 | sed -E "s/${RELAY_TRANSFER_SOURCE_TOKEN}|${RELAY_TRANSFER_TARGET_TOKEN}/[redacted]/g; s/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[jwt-redacted]/g; s/\x1b\[[0-9;]*m//g" | grep -Ei 'fatal|error|failed' | tail -3 | cut -c1-280 || true)
    while IFS= read -r message; do [[ -z "$message" ]] || printf '::warning::%s\n' "$message"; done <<< "$diagnostics"
  done
  exit 1
fi
if [[ "${RELAY_TRANSFER_SCENARIO:-}" == corrupt-archive ]]; then
  # Confirm the real receiver refused the checksum, not authorization or extraction.
  receiver_log=$(docker logs "$dst" 2>&1)
  grep -qF "checksums don't match" <<< "$receiver_log"
  echo 'Wings receiver rejected the deliberately changed gzip header checksum'
fi
