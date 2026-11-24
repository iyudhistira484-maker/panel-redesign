# Application API inventory

Paths relative to `/api/application`. Binding annotations are not literal URL characters. All entries are source-observed, runtime untested. See [compatibility policy](architecture.md#compatibility-policy).

| Method | Path |
|---|---|
| GET | `/users` |
| GET | `/users/{user:id}` |
| GET | `/users/external/{external_id}` |
| POST | `/users` |
| PATCH | `/users/{user:id}` |
| DELETE | `/users/{user:id}` |
| GET | `/nodes` |
| GET | `/nodes/deployable` |
| GET | `/nodes/{node:id}` |
| GET | `/nodes/{node:id}/configuration` |
| POST | `/nodes` |
| PATCH | `/nodes/{node:id}` |
| DELETE | `/nodes/{node:id}` |
| GET | `/nodes/{node:id}/allocations` |
| POST | `/nodes/{node:id}/allocations` |
| DELETE | `/nodes/{node:id}/allocations/{allocation:id}` |
| GET | `/locations` |
| GET | `/locations/{location:id}` |
| POST | `/locations` |
| PATCH | `/locations/{location:id}` |
| DELETE | `/locations/{location:id}` |
| GET | `/servers` |
| GET | `/servers/{server:id}` |
| GET | `/servers/external/{external_id}` |
| PATCH | `/servers/{server:id}/details` |
| PATCH | `/servers/{server:id}/build` |
| PATCH | `/servers/{server:id}/startup` |
| POST | `/servers` |
| POST | `/servers/{server:id}/suspend` |
| POST | `/servers/{server:id}/unsuspend` |
| POST | `/servers/{server:id}/reinstall` |
| DELETE | `/servers/{server:id}` |
| DELETE | `/servers/{server:id}/{force?}` |
| GET | `/servers/{server:id}/databases` |
| GET | `/servers/{server:id}/databases/{database:id}` |
| POST | `/servers/{server:id}/databases` |
| POST | `/servers/{server:id}/databases/{database:id}/reset-password` |
| DELETE | `/servers/{server:id}/databases/{database:id}` |
| GET | `/nests` |
| GET | `/nests/{nest:id}` |
| GET | `/nests/{nest:id}/eggs` |
| GET | `/nests/{nest:id}/eggs/{egg:id}` |
