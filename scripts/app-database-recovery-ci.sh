#!/usr/bin/env bash
set -euo pipefail
# Dedicated CI fixture only: the Relay control-plane database is never dumped or restored here.
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${GITHUB_WORKFLOW:-}" == Foundation && "${RELAY_ENV:-}" == staging ]]
service=${RELAY_APP_DB_CI_SERVICE:?}
recovery=${RELAY_APP_DB_RECOVERY_SERVICE:?}
[[ "$service" =~ ^[a-f0-9]{64}$ && "$recovery" =~ ^[a-f0-9]{64}$ && "$service" != "$recovery" ]]
for container in "$service" "$recovery"; do
  [[ "$(docker inspect --format '{{.Config.Image}}' "$container")" == mysql:8.4.8 ]]
done
umask 077
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

root() {
  local container=$1; shift
  docker exec -i "$container" sh -ec 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --default-character-set=utf8mb4 "$@"' sh "$@"
}
app() {
  local container=$1; shift
  docker exec -i "$container" sh -ec 'MYSQL_PWD="$1"; export MYSQL_PWD; shift; exec mysql "$@"' sh "$@"
}
# These accounts and schemas exist only for the lifetime of the runner service.
root "$service" <<'SQL'
CREATE DATABASE relay_app_source CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'fixture_app_reader'@'localhost' IDENTIFIED BY 'disposable-app-reader';
CREATE USER 'fixture_app_writer'@'localhost' IDENTIFIED BY 'disposable-app-writer';
GRANT SELECT ON relay_app_source.* TO 'fixture_app_reader'@'localhost';
GRANT SELECT, UPDATE ON relay_app_source.* TO 'fixture_app_writer'@'localhost';
USE relay_app_source;
CREATE TABLE accounts (id INT PRIMARY KEY, balance INT NOT NULL, label VARCHAR(64) NOT NULL) ENGINE=InnoDB;
CREATE TABLE ledger (id INT PRIMARY KEY, account_id INT NOT NULL, amount INT NOT NULL, payload VARBINARY(64) NOT NULL, metadata JSON NOT NULL, FOREIGN KEY (account_id) REFERENCES accounts(id)) ENGINE=InnoDB;
INSERT INTO accounts VALUES (1,80,'Kopi • Surabaya'),(2,20,'Cadangan');
INSERT INTO ledger VALUES (1,1,80,UNHEX('000A0D80FF'),JSON_OBJECT('reason','checkpoint')),(2,2,20,UNHEX('00FF'),JSON_OBJECT('reason','checkpoint'));
SQL
reader() { app "$service" disposable-app-reader -ufixture_app_reader --default-character-set=utf8mb4 "$@"; }
writer() { app "$service" disposable-app-writer -ufixture_app_writer --default-character-set=utf8mb4 "$@"; }
restore() { app "$recovery" disposable-app-restore -ufixture_app_restore --default-character-set=utf8mb4 "$@"; }
source_uuid=$(root "$service" -NBr -e 'SELECT @@server_uuid')
recovery_uuid=$(root "$recovery" -NBr -e 'SELECT @@server_uuid')
[[ "$source_uuid" =~ ^[0-9a-f-]{36}$ && "$recovery_uuid" =~ ^[0-9a-f-]{36}$ && "$source_uuid" != "$recovery_uuid" ]]
[[ "$(root "$recovery" -NBr -e "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'relay\_app\_%'")" == 0 ]]
root "$recovery" <<'SQL'
CREATE DATABASE relay_app_recovery CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'fixture_app_restore'@'localhost' IDENTIFIED BY 'disposable-app-restore';
CREATE USER 'fixture_app_runtime'@'%' IDENTIFIED BY 'disposable-app-runtime';
GRANT ALL PRIVILEGES ON relay_app_recovery.* TO 'fixture_app_restore'@'localhost';
SQL
snapshot='SELECT id,balance,HEX(label) FROM accounts ORDER BY id; SELECT id,account_id,amount,HEX(payload),JSON_UNQUOTE(JSON_EXTRACT(metadata,"$.reason")) FROM ledger ORDER BY id;'
[[ "$(reader -NBr relay_app_source -e 'SELECT HEX(label) FROM accounts WHERE id=1')" == 4B6F706920E280A2205375726162617961 ]]
reader -NBr relay_app_source -e "$snapshot" >"$work/checkpoint.rows"
if reader relay_app_source -e 'UPDATE accounts SET balance=0' >"$work/unexpected" 2>&1; then echo '::error::Backup reader unexpectedly has write access'; exit 1; fi
if app "$service" disposable-app-restore -ufixture_app_restore relay_app_source -e 'SELECT id FROM accounts' >"$work/unexpected" 2>&1; then echo '::error::Restore identity can read the source'; exit 1; fi

# Keep a transfer transaction open while mysqldump reads the committed snapshot.
writer relay_app_source >"$work/writer.out" <<'SQL' &
START TRANSACTION;
UPDATE accounts SET balance=70 WHERE id=1;
UPDATE ledger SET amount=70,metadata=JSON_OBJECT('reason','after checkpoint') WHERE id=1;
SELECT GET_LOCK('relay_app_fixture_writer_open',0);
SELECT SLEEP(12);
UPDATE accounts SET balance=30 WHERE id=2;
UPDATE ledger SET amount=30,metadata=JSON_OBJECT('reason','after checkpoint') WHERE id=2;
COMMIT;
SELECT RELEASE_LOCK('relay_app_fixture_writer_open');
SQL
writer_pid=$!
writer_open() { [[ "$(reader -NBr -e "SELECT IS_USED_LOCK('relay_app_fixture_writer_open') IS NOT NULL")" == 1 ]]; }
for _ in {1..25}; do
  if writer_open; then break; fi
  kill -0 "$writer_pid" 2>/dev/null || { echo '::error::Application writer stopped before backup'; exit 1; }
  sleep .2
done
writer_open || { echo '::error::Application writer transaction did not open'; exit 1; }
started=$(date +%s%3N)
docker exec "$service" sh -ec 'MYSQL_PWD=disposable-app-reader exec mysqldump -ufixture_app_reader --default-character-set=utf8mb4 --single-transaction --no-tablespaces --set-gtid-purged=OFF --skip-lock-tables --skip-triggers --hex-blob relay_app_source' >"$work/checkpoint.sql"
backup_ms=$(( $(date +%s%3N) - started ))
writer_open || { echo '::error::Backup did not overlap the open application write transaction'; exit 1; }
wait "$writer_pid"
test -s "$work/checkpoint.sql"
(cd "$work" && sha256sum checkpoint.sql > checkpoint.sha256 && sha256sum --check --status checkpoint.sha256)
cp "$work/checkpoint.sql" "$work/corrupt.sql"
printf '\n-- altered fixture\n' >>"$work/corrupt.sql"
if cmp -s "$work/checkpoint.sql" "$work/corrupt.sql" || [[ "$(sha256sum "$work/corrupt.sql" | cut -d ' ' -f1)" == "$(cut -d ' ' -f1 "$work/checkpoint.sha256")" ]]; then
  echo '::error::Corrupted dump passed checksum comparison'; exit 1
fi

reader -NBr relay_app_source -e "$snapshot" >"$work/current.rows"
if cmp -s "$work/checkpoint.rows" "$work/current.rows"; then echo '::error::Source did not advance after checkpoint'; exit 1; fi
started=$(date +%s%3N)
restore relay_app_recovery <"$work/checkpoint.sql"
restore_ms=$(( $(date +%s%3N) - started ))
restore -NBr relay_app_recovery -e "$snapshot" >"$work/restored.rows"
cmp "$work/checkpoint.rows" "$work/restored.rows"
[[ "$(restore -NBr relay_app_recovery -e 'SELECT SUM(balance) FROM accounts; SELECT SUM(amount) FROM ledger')" == $'100\n100' ]]
if restore relay_app_recovery -e "INSERT INTO ledger VALUES (9,99,1,UNHEX('AB'),JSON_OBJECT('reason','invalid'))" >"$work/unexpected" 2>&1; then echo '::error::Recovered schema did not enforce foreign key'; exit 1; fi
restore relay_app_recovery -e "START TRANSACTION; INSERT INTO ledger VALUES (9,1,1,UNHEX('AB'),JSON_OBJECT('reason','smoke')); ROLLBACK;"
[[ "$(restore -NBr relay_app_recovery -e 'SELECT COUNT(*) FROM ledger WHERE id=9')" == 0 ]]
root "$recovery" <<'SQL'
GRANT SELECT, UPDATE ON relay_app_recovery.accounts TO 'fixture_app_runtime'@'%';
GRANT SELECT, INSERT ON relay_app_recovery.ledger TO 'fixture_app_runtime'@'%';
SQL
RELAY_EXPECTED_RECOVERY_UUID="$recovery_uuid" ./node_modules/.bin/tsx api/wings/app-database-smoke.ts
reader -NBr relay_app_source -e "$snapshot" >"$work/source-after-restore.rows"
cmp "$work/current.rows" "$work/source-after-restore.rows"
printf '::notice::Application MySQL restore: backup_ms=%s restore_ms=%s fresh_mysql_instance=true http_read_write_restart=true concurrent_writer=true checkpoint_rows_match=true binary_json_verified=true foreign_key_enforced=true source_unchanged=true tamper_detected=true\n' "$backup_ms" "$restore_ms"
