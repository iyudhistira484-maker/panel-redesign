# API route parity audit

Baseline: Panel Pterodactyl v1.15.2 inventories. Generated from Relay route registrations (no network or DB handlers invoked). **Registered does not mean compatible**: permissions, response formats, lifecycle and supported workloads still need behavior tests. A Relay-native `/api/v1` endpoint does not count as a compatibility route.

## client

69 upstream entries: **20 registered**, **0 disposable Wings only**, **49 not registered**.

| Method | Upstream path | Relay registration |
| --- | --- | --- |
| GET | `/` | Registered |
| GET | `/permissions` | Registered |
| GET | `/account` | Registered |
| GET | `/account/two-factor` | Not registered |
| POST | `/account/two-factor` | Not registered |
| POST | `/account/two-factor/disable` | Not registered |
| PUT | `/account/email` | Not registered |
| PUT | `/account/password` | Not registered |
| GET | `/account/activity` | Not registered |
| GET | `/account/api-keys` | Not registered |
| POST | `/account/api-keys` | Not registered |
| DELETE | `/account/api-keys/{identifier}` | Not registered |
| GET | `/account/ssh-keys` | Registered |
| POST | `/account/ssh-keys` | Registered |
| POST | `/account/ssh-keys/remove` | Registered |
| GET | `/servers/{server}` | Registered |
| GET | `/servers/{server}/websocket` | Registered |
| GET | `/servers/{server}/resources` | Registered |
| GET | `/servers/{server}/activity` | Not registered |
| POST | `/servers/{server}/command` | Registered |
| POST | `/servers/{server}/power` | Registered |
| GET | `/servers/{server}/databases` | Not registered |
| POST | `/servers/{server}/databases` | Not registered |
| POST | `/servers/{server}/databases/{database}/rotate-password` | Not registered |
| DELETE | `/servers/{server}/databases/{database}` | Not registered |
| GET | `/servers/{server}/files/list` | Registered |
| GET | `/servers/{server}/files/contents` | Registered |
| GET | `/servers/{server}/files/download` | Registered |
| PUT | `/servers/{server}/files/rename` | Registered |
| POST | `/servers/{server}/files/copy` | Not registered |
| POST | `/servers/{server}/files/write` | Registered |
| POST | `/servers/{server}/files/compress` | Registered |
| POST | `/servers/{server}/files/decompress` | Not registered |
| POST | `/servers/{server}/files/delete` | Registered |
| POST | `/servers/{server}/files/create-folder` | Not registered |
| POST | `/servers/{server}/files/chmod` | Registered |
| POST | `/servers/{server}/files/pull` | Not registered |
| GET | `/servers/{server}/files/upload` | Registered |
| GET | `/servers/{server}/schedules` | Not registered |
| POST | `/servers/{server}/schedules` | Not registered |
| GET | `/servers/{server}/schedules/{schedule}` | Not registered |
| POST | `/servers/{server}/schedules/{schedule}` | Not registered |
| POST | `/servers/{server}/schedules/{schedule}/execute` | Not registered |
| DELETE | `/servers/{server}/schedules/{schedule}` | Not registered |
| POST | `/servers/{server}/schedules/{schedule}/tasks` | Not registered |
| POST | `/servers/{server}/schedules/{schedule}/tasks/{task}` | Not registered |
| DELETE | `/servers/{server}/schedules/{schedule}/tasks/{task}` | Not registered |
| GET | `/servers/{server}/network/allocations` | Not registered |
| POST | `/servers/{server}/network/allocations` | Not registered |
| POST | `/servers/{server}/network/allocations/{allocation}` | Not registered |
| POST | `/servers/{server}/network/allocations/{allocation}/primary` | Not registered |
| DELETE | `/servers/{server}/network/allocations/{allocation}` | Not registered |
| GET | `/servers/{server}/users` | Not registered |
| POST | `/servers/{server}/users` | Not registered |
| GET | `/servers/{server}/users/{user}` | Not registered |
| POST | `/servers/{server}/users/{user}` | Not registered |
| DELETE | `/servers/{server}/users/{user}` | Not registered |
| GET | `/servers/{server}/backups` | Not registered |
| POST | `/servers/{server}/backups` | Not registered |
| GET | `/servers/{server}/backups/{backup}` | Not registered |
| GET | `/servers/{server}/backups/{backup}/download` | Not registered |
| POST | `/servers/{server}/backups/{backup}/lock` | Not registered |
| POST | `/servers/{server}/backups/{backup}/restore` | Not registered |
| DELETE | `/servers/{server}/backups/{backup}` | Not registered |
| GET | `/servers/{server}/startup` | Not registered |
| PUT | `/servers/{server}/startup/variable` | Not registered |
| POST | `/servers/{server}/settings/rename` | Not registered |
| POST | `/servers/{server}/settings/reinstall` | Not registered |
| PUT | `/servers/{server}/settings/docker-image` | Not registered |

## application

42 upstream entries: **8 registered**, **0 disposable Wings only**, **34 not registered**.

| Method | Upstream path | Relay registration |
| --- | --- | --- |
| GET | `/users` | Not registered |
| GET | `/users/{user:id}` | Not registered |
| GET | `/users/external/{external_id}` | Not registered |
| POST | `/users` | Not registered |
| PATCH | `/users/{user:id}` | Not registered |
| DELETE | `/users/{user:id}` | Not registered |
| GET | `/nodes` | Registered |
| GET | `/nodes/deployable` | Not registered |
| GET | `/nodes/{node:id}` | Registered |
| GET | `/nodes/{node:id}/configuration` | Not registered |
| POST | `/nodes` | Not registered |
| PATCH | `/nodes/{node:id}` | Not registered |
| DELETE | `/nodes/{node:id}` | Not registered |
| GET | `/nodes/{node:id}/allocations` | Registered |
| POST | `/nodes/{node:id}/allocations` | Not registered |
| DELETE | `/nodes/{node:id}/allocations/{allocation:id}` | Not registered |
| GET | `/locations` | Not registered |
| GET | `/locations/{location:id}` | Not registered |
| POST | `/locations` | Not registered |
| PATCH | `/locations/{location:id}` | Not registered |
| DELETE | `/locations/{location:id}` | Not registered |
| GET | `/servers` | Registered |
| GET | `/servers/{server:id}` | Registered |
| GET | `/servers/external/{external_id}` | Registered |
| PATCH | `/servers/{server:id}/details` | Not registered |
| PATCH | `/servers/{server:id}/build` | Not registered |
| PATCH | `/servers/{server:id}/startup` | Not registered |
| POST | `/servers` | Registered |
| POST | `/servers/{server:id}/suspend` | Not registered |
| POST | `/servers/{server:id}/unsuspend` | Not registered |
| POST | `/servers/{server:id}/reinstall` | Not registered |
| DELETE | `/servers/{server:id}` | Registered |
| DELETE | `/servers/{server:id}/{force?}` | Not registered |
| GET | `/servers/{server:id}/databases` | Not registered |
| GET | `/servers/{server:id}/databases/{database:id}` | Not registered |
| POST | `/servers/{server:id}/databases` | Not registered |
| POST | `/servers/{server:id}/databases/{database:id}/reset-password` | Not registered |
| DELETE | `/servers/{server:id}/databases/{database:id}` | Not registered |
| GET | `/nests` | Not registered |
| GET | `/nests/{nest:id}` | Not registered |
| GET | `/nests/{nest:id}/eggs` | Not registered |
| GET | `/nests/{nest:id}/eggs/{egg:id}` | Not registered |

See [replacement gates](pterodactyl-replacement.md) for UI, migration, operator and rollout work outside this API audit.
