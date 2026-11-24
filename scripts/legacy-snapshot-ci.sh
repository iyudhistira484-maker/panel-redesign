#!/usr/bin/env bash
set -euo pipefail
[[ "${RELAY_ENV:-}" == staging && "${RELAY_DISPOSABLE_WINGS_CI:-}" == 1 ]]
password=${RELAY_LEGACY_SNAPSHOT_CI_PASSWORD:?}
[[ "$password" =~ ^[a-f0-9]{48}$ ]]
client=(docker exec -i -e "MYSQL_PWD=$password" relay-adoption-db mariadb -uroot)
"${client[@]}" <<SQL
CREATE DATABASE panel_snapshot_ci;
CREATE USER 'relay_snapshot'@'%' IDENTIFIED BY '$password';
GRANT SELECT ON panel_snapshot_ci.* TO 'relay_snapshot'@'%';
SQL
docker exec -e "MYSQL_PWD=$password" relay-adoption-db mariadb-dump -uroot --single-transaction --no-tablespaces panel_adoption_fixture |
  "${client[@]}" panel_snapshot_ci
