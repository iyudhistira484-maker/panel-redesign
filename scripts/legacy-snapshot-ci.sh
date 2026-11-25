#!/usr/bin/env bash
set -euo pipefail
[[ "${RELAY_ENV:-}" == staging && "${RELAY_DISPOSABLE_WINGS_CI:-}" == 1 && "${RUNNER_ENVIRONMENT:-}" == github-hosted && ( "${GITHUB_EVENT_NAME:-}" == push || ( "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_WORKFLOW:-}" == "Relay Wings off-host staging" ) ) ]]
password=${RELAY_LEGACY_SNAPSHOT_CI_PASSWORD:?}
reader_password=${RELAY_LEGACY_SNAPSHOT_READER_PASSWORD:?}
[[ "$password" =~ ^[a-f0-9]{48}$ && "$reader_password" =~ ^[a-f0-9]{48}$ && "$reader_password" != "$password" ]]
client=(docker exec -i -e "MYSQL_PWD=$password" relay-adoption-db mariadb -uroot)
"${client[@]}" <<SQL
CREATE DATABASE panel_snapshot_ci;
SQL
docker exec -e "MYSQL_PWD=$password" relay-adoption-db mariadb-dump -uroot --single-transaction --no-tablespaces panel_adoption_fixture |
  "${client[@]}" panel_snapshot_ci
"${client[@]}" <<SQL
CREATE USER 'relay_snapshot'@'%' IDENTIFIED BY '$reader_password';
GRANT SELECT (id,uuid,external_id,owner_id,node_id,egg_id,nest_id,allocation_id,status,installed_at) ON panel_snapshot_ci.servers TO 'relay_snapshot'@'%';
GRANT SELECT (id,uuid) ON panel_snapshot_ci.users TO 'relay_snapshot'@'%';
GRANT SELECT (id,uuid) ON panel_snapshot_ci.nodes TO 'relay_snapshot'@'%';
GRANT SELECT (id,uuid) ON panel_snapshot_ci.nests TO 'relay_snapshot'@'%';
GRANT SELECT (id,uuid,nest_id) ON panel_snapshot_ci.eggs TO 'relay_snapshot'@'%';
GRANT SELECT (id,node_id,server_id,ip,port) ON panel_snapshot_ci.allocations TO 'relay_snapshot'@'%';
GRANT SELECT (id,user_id,server_id,permissions) ON panel_snapshot_ci.subusers TO 'relay_snapshot'@'%';
SQL
