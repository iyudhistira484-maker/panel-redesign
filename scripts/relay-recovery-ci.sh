#!/usr/bin/env bash
set -euo pipefail
[[ "${RELAY_ENV:-}" == staging && "${RELAY_DISPOSABLE_WINGS_CI:-}" == 1 && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${GITHUB_EVENT_NAME:-}" == push && "${RELAY_BOOTSTRAP_SCENARIO:-}" == legacy-panel ]]
service=${RELAY_RECOVERY_MYSQL_SERVICE:?}
[[ "$service" =~ ^[a-f0-9]{64}$ && "${RELAY_STAGING_DATABASE_URL:-}" == */relay_test ]]
backup=${2:?}
[[ "$backup" =~ ^/tmp/tmp\.[A-Za-z0-9]+/relay-recovery\.sql$ && -O "$(dirname "$backup")" ]]
umask 077
case ${1:-} in
  backup)
    set -o noclobber
    docker exec "$service" sh -ec 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --no-tablespaces --set-gtid-purged=OFF relay_test' > "$backup"
    test -s "$backup"
    ;;
  restore)
    test -f "$backup" && test ! -L "$backup" && test -O "$backup"
    docker exec "$service" sh -ec 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -e "CREATE DATABASE relay_test_recovery; GRANT ALL PRIVILEGES ON relay_test_recovery.* TO '\''relay'\''@'\''%'\'';"'
    docker exec -i "$service" sh -ec 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot relay_test_recovery' < "$backup"
    ;;
  *) exit 2 ;;
esac
