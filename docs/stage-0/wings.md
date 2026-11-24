# Wings contract — source baseline, runtime unverified

Candidate support range **=1.13.5 only**; no runtime-certified range yet. Wire behavior below is from Wings `router/router.go`, `router/middleware`, `router/tokens`, `router/websocket`, `server/events.go`, `remote/{http,servers,types}.go` and Panel `routes/api-remote.php`, `app/Repositories/Wings`, `app/Services/Nodes/NodeJWTService.php`, and client server controllers. Pin the resulting image digest before qualification. Expand only after the same suite passes on each added release.

## Panel → Wings

TLS; protected REST uses `Authorization: Bearer <node token>` (no ID prefix). Resolve the node from the authorized server, not caller-supplied URLs. All calls go through one adapter. Treat HTTP acceptance of install, power, backup or transfer as distinct from completion. Reconcile ambiguous timeouts; never retry a destructive write blindly.

| Prefix | Methods and suffixes |
|---|---|
| `/api` | GET `/system`, `/servers`; POST `/servers`, `/update`, `/deauthorize-user`; DELETE `/transfers/:server` |
| `/api/servers/:server` | GET root and `/logs`; DELETE root; POST `/power`, `/commands`, `/install`, `/reinstall`, `/sync`, `/ws/deny`, `/transfer`; DELETE `/transfer` |
| `/api/servers/:server/files` | GET `/contents`, `/list-directory`; PUT `/rename`; POST `/copy`, `/write`, `/create-directory`, `/delete`, `/compress`, `/decompress`, `/chmod`; GET/POST `/pull`, DELETE `/pull/:download` when remote download enabled |
| `/api/servers/:server/backup` | POST root, POST `/:backup/restore`, DELETE `/:backup` |
| Transfer receiver | POST `/api/transfers` with transfer JWT; destination receives archive, Panel reconciles via remote completion before changing node/allocation ownership |
| Direct file/backup transport | GET `/download/file`, `/download/backup`; POST `/upload/file` (multipart); scoped `token` query credential. S3 uses signed object storage URLs instead of local backup download. |

## Browser → Wings

Connect to `/api/servers/:server/ws`. Frame shape is `event` plus `args` array. Send `auth` with token, await `auth success`, then request `send logs` or `send stats`; sends use `send command` or `set state` under granted permissions. Receive `console output`, `stats`, `status`, daemon messages, install/backup/transfer lifecycle events; handle `jwt error`, `daemon error`, `throttled`, `token expiring` (fetch fresh authorized token and re-authenticate) and `token expired` (stop privileged traffic). Test origin checks, refresh, connection limits, revoked grants and reconnect behavior. Do not assume state can be inferred from console output.

Panel signs JWTs with HS256 and the intended Wings node secret. Preserve `iss`, `aud`, `jti`, `iat`, `nbf`, `exp` per upstream issuance, and use `scope` plus purpose-bound claims. The shared Wings parser verifies signature and expiration; binding and scope are handler checks, not assertions about enforcement of other registered claims. Use upstream expiry baseline: 10 min WS, 15 min file URLs; backup expiry and capability replay behavior to confirm from call sites and real tests. Never log query tokens, frame auth or transfer headers.

| Scope | Additional binding |
|---|---|
| `websocket` | `server_uuid`, `user_uuid`, `permissions` |
| `file-upload` | `server_uuid`, `user_uuid`, `unique_id` |
| `file-download` | above plus `file_path` |
| `backup-download` | upload identifiers plus `backup_uuid` |
| `transfer` | destination-node signature and server UUID in `sub` (15 min upstream); separate from ordinary REST auth |

Use the upstream revocation endpoints for permission changes and account revocation. Explicitly test expiry, use of the wrong node/server/scope, replay semantics, disconnect behavior and capability lifetime after authorization changes. If revocation is weaker than required, assess a broker or narrower capabilities before enabling the affected operation.

## Wings → Panel

Base `/api/remote`, authorization `Bearer <token_id>.<token>`; resolve node by ID and verify secret in constant time. Node ownership must be checked for every UUID, with explicit source/destination roles for transfers. Never reuse this credential for client APIs.

| Method and path | Purpose |
|---|---|
| GET `/servers` | Paginated node server configurations (`data`, pagination `meta`); pinned daemon sends `page=0` for its first request, normalize to page 1 |
| GET `/servers/{uuid}` | Server settings and egg process configuration; validate environment, resource limits, allocations, mounts, image and startup fields |
| POST `/servers/reset` | Reconcile transient state on daemon boot; constrain updates to that node |
| GET `/servers/{uuid}/install` | Installation script, container, entrypoint |
| POST `/servers/{uuid}/install` | Installation result |
| POST `/servers/{uuid}/transfer/{success\|failure}` | Transfer completion; deduplicate and validate transition |
| GET `/backups/{backup}` | S3 multipart signing at requested size |
| POST `/backups/{backup}` | Backup result, size/checksum and upload completion metadata |
| POST `/backups/{backup}/restore` | Restore outcome |
| POST `/sftp/auth` | Resolve server/user and validate password or SSH key; return effective permissions. Wings owns SSH transport and filesystem enforcement. |
| POST `/activity` | Batch activity under `data`; validate ownership, actor and event schema |

Wings also has an archive-status client method posting `/servers/{uuid}/archive`; no matching route in pinned Panel. Confirm reachability; do not invent a success response. Exact payloads, error envelopes/status codes and edge cases require captured, sanitized tests before marking this contract complete.

## Adoption and limits

Keep node ID/token, server UUIDs, allocation mappings, Wings root/TLS/SFTP config, mounts and existing volumes. Back up config, then change only the staging node `remote` URL and restart/reload as qualified. Verify WS browser origin and TLS as well as callbacks; stop if Wings attempts to recreate an existing server. SFTP and direct uploads bypass Panel writes: later config history cannot truthfully cover all writes without a constrained workflow or a redesigned guarantee. No Wings patch. File pull is gated until daemon-side destination controls are verified; Panel-side URL validation alone does not control Wings DNS/redirects.
