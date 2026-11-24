# Schema map and migration plan

Baseline: Panel `database/schema/mysql-schema.sql`, **plus** pending migrations in `database/migrations`, cross-checked against `app/Models`. The SQL baseline is not a substitute for inspecting `information_schema` and the migration ledger on a sanitized copy of the actual source. Unrecognized tables, columns, plugin data and divergent constraints require a disposition before rehearsal. No production connections.

| Legacy table | Target and mapping |
|---|---|
| `users` | Identity principal: IDs, UUID, external ID, email/name, locale, admin flag, bcrypt hash, TOTP with encrypted secret; discard remembered sessions |
| `recovery_tokens` | Identity recovery verifiers; preserve only after testing hash semantics, otherwise approved regeneration |
| `user_ssh_keys` | Identity keys linked to user; preserve fingerprints/public keys, verify SFTP callback |
| `api_keys` | Integration credentials: identifier/type, owner, expiry, scopes/legacy ACL and network restrictions; decrypt legacy token in isolated import and store keyed verifier |
| `nodes` | Node profile: location, address/TLS, ports, daemon root, capacity/overcommit, token ID and re-encrypted token |
| `locations` | Node region/code and description |
| `servers` | Workload: UUID/short ID/external ID, owner, node, nest/egg, primary allocation, startup/image, limits, status and timestamps |
| `allocations` | Node address/alias/port assignment, optional server, notes; verify uniqueness and primary allocation belongs to server and node |
| `nests` | Catalog groups; preserve IDs and names |
| `eggs` | Workload definition: nest, UUID, image map, startup, inherited config/script references, features, denylist, install data |
| `egg_variables` | Egg schema: env name, default, validation rule, user visibility/editability |
| `server_variables` | Server/egg-variable overrides; check references belong to the effective egg |
| `backups` | Backup UUID, server, adapter, checksum, bytes, ignored paths, lock and completion; do not resume multipart upload IDs |
| `server_transfers` | Transfer history, node and allocation references; active transfers block freeze |
| `database_hosts` | Database host address, port, admin username, re-encrypted credential, optional node |
| `databases` | Server-to-host DB binding, DB/user names, allowed remote source and re-encrypted password; no host writes |
| `subusers` | Server membership and exact JSON permission grants; verify effective privileges before/after |
| `schedules` | Server schedule, cron fields, active/online-only, last/next run; clear in-progress state after quiescence, keep execution disabled on import |
| `tasks` | Ordered schedule action, payload, offset and continue-on-failure; do not replay pending work |
| `mounts` | Admin-reviewed source/target, read-only and user-mountable flags |
| `mount_node` | Mount availability on node |
| `mount_server` | Server mount attachments |
| `egg_mount` | Mount eligibility on egg |
| `activity_logs` | Activity actor/credential, event, time, IP and validated properties; retain/redact per agreed policy |
| `activity_log_subjects` | Link polymorphic subjects using allow-listed type mappings; tombstone deleted subjects without granting access |
| `audit_logs` | Historical audit archive, segregated from new audit writes |
| `api_logs` | Historical API archive if populated; redact before making searchable |
| `tasks_log` | Historical schedule archive if populated; do not replay |
| `settings` | Evaluate each key: allow-listed settings mapped explicitly; encrypted SMTP password re-encrypted; unsafe/unknown settings quarantined |
| `notifications` | Classify as legacy notification archive if populated; never redispatch |
| `jobs`, `failed_jobs` | Operational records only; report counts, do not deserialize or execute |
| `password_resets`, `sessions` | Intentionally expire; re-authenticate and request new resets |
| `migrations` | Capture source provenance; never replace target migration ledger |

## Rehearsal and cutover gates

1. Verify a full, restorable backup exists before import; include DB, APP_KEY in separate secret escrow, Wings configs/volumes, database-server data and backup object inventory. Obtain approval for copy handling, disable outbound email and restrict staging egress. Use distinct credentials for all rehearsal endpoints; isolate any retained credentials and never point rehearsal at production.
2. Restore copy in private staging; inventory source version, schema fingerprint, table counts and storage locations. Take consistent snapshot; read-only source role. Run dry-run: normalize/order rows, validate all refs, encrypted fields, hashes and permission sets without writing to target or external systems. Report blocking issues with opaque record refs, never raw secret data.
3. Use source-instance + table + source PK mapping and unique constraints, transactional checkpoints and content digests. Preserve externally visible identifiers. An identical rerun is a no-op; changed snapshots need explicit conflict review, not silent overwrite of target edits. Import parents before children; resolve primary allocations and polymorphic links in a second pass. Make interrupted runs resumable; test rerun, partial failure and rollback to target snapshot.
4. Legacy Laravel decryption uses the copy's APP_KEY and configured cipher; authenticate ciphertext before deserializing only expected scalar values in an isolated process. No plaintext exports. Re-encrypt TOTP, DB and SMTP credentials and node tokens with new keys; API token verifiers retain integration compatibility only after validation. Never reuse APP_KEY as target key. Missing key or decryption failures block parity unless explicit credential resets are agreed. Verify bcrypt variants on fixture login and atomically rehash valid credentials to Argon2id; no forced reset by default.
5. Produce manifest: per-table read/insert/match/quarantine/exclude totals, zero unexplained differences, FK/uniqueness checks, grant comparisons, verified login + 2FA/SFTP/API key examples, saved schedules with no duplicate execution, and sampled local/S3 backup restore against copied artifacts. DB metadata is not server volume data. Make schedule ownership singular before enabling jobs.
6. Stage 10 approval precedes rollout planning. Stage 14 is a separate authorization: notify users and choose low-traffic window; freeze old writes and workers, drain installs/transfers/backups, snapshot and verify; canary one isolated non-critical node then batches. For each, record last healthy time, switch Wings remote, verify heartbeat/startup/console/SFTP/backups and reconcile before widening. Abort on unexpected container changes, privilege drift, missing data or callback failures.
7. Keep old panel/DB untouched at freeze, and original node configs available. Rollback: stop new writes/workers, isolate new callbacks, restore old node configs, restart Wings and verify old control path, then resume old workers. After target-side writes, do not blindly switch back: reconcile allocations, transfers, secrets, files and completed tasks with an approved data-loss boundary. Time the drill and document RPO/RTO before canary.
