# Pterodactyl integration inventory for the Relay pilot

## What is known

This checkout contains the panel, compatibility adapters and their tests, but no external bot or provisioning consumer. The names of services on the operator's VPS do not establish which API routes they call. No VPS was queried. Consequently, the operator's actual integration coverage is **unknown**, not zero and not qualified.

| Candidate integration flow | Evidence in this repository | Qualification needed |
| --- | --- | --- |
| Read server state; send power or console commands | Client routes registered; staged Wings contracts exist | Run the actual bot's requests with equivalent least-privilege credentials; verify its expected IDs, response fields and errors. |
| List, read, download or write files | Legacy-panel suite compares ordinary directory entries and provides content, download and permission checks | Compare the paths, binary handling, symlinks and mutation semantics the consumer actually needs. Relay intentionally filters symlinks on the tested listing. |
| Find server by external ID; list servers, nodes and allocations | Application adapters registered, with separate scoped keys and staging inventory checks | Map numeric identifiers rather than assuming they survive migration; test pagination/query features and required fields. |
| Create/delete a workload | Application adapters have a restricted disposable fixture contract | Do not enable live writes for the pilot on the strength of the fixture. Test the real request shape, lifecycle, retry/reconciliation and wrong-scope denial. |
| Billing, quotas, account creation, suspend/unsuspend, startup changes or scheduled jobs | No consumer found here; several compatibility routes are absent in the [route audit](api-parity-audit.md) | Treat as blockers if confirmed in use. Native `/api/v1` support is not a substitute for an unchanged consumer. |

## Input to complete the inventory

Use a source checkout of the bot or the integrator's sanitized route list. For each action, record the method, path **template** (replace IDs), query parameter **names**, required response fields, credential type/scope, whether it mutates state, and retry behavior. Do not include credentials, message content, request bodies with user data, or production URLs. If the bot only links to a panel and does not use its API, record that separately.

## Qualification order

1. Run read-only paths against staging Pterodactyl and Relay; normalize generated identifiers and compare the fields and statuses the consumer uses.
2. Reproduce writes on a disposable workload with fresh credentials, asserting both the API response and Wings/storage effects. Include expired or insufficient scopes, retries and uncertain outcomes. A route registration or equal status alone is not a pass.
3. Pilot only when every required flow has evidence or is explicitly out of scope. Keep the legacy configuration available for rollback; do not touch production without operator approval.
