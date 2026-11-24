# Threat model — OWASP ASVS Level 2 baseline

Assets: tenant servers/files, runtime and database credentials, auth factors, backups, audit history and availability. Trust boundaries: untrusted browser/client → Panel; Panel/queue → Wings/DB/storage; Wings callbacks → Panel; staged import operator → isolated import; external service → future public endpoints. A compromised node is trusted for its own tenants' workloads only, not the fleet. No unreviewed secrets or identifiers in logs.

| Threat | Required controls and verification |
|---|---|
| Credential stuffing/session theft | Argon2id plus verified bcrypt upgrade; rate limits per account/IP, TOTP and single-use hashed recovery codes; generic reset responses, secure HTTP-only SameSite cookies, CSRF and rotation, session invalidation tests |
| Cross-tenant IDOR/privilege escalation | Deny-by-default central policy; bind nested resources to server and node, no caller-selected authorization subject; matrix tests for REST, WS token issuance/revocation, SFTP, queued work and legacy routes |
| Compromised callback node/replay | Scope node token to node; validate state and ownership, deduplicate callbacks, enforce TLS and validate WS origin; negative tests on cross-node UUIDs and expired capabilities |
| Secret disclosure and stolen DB | Envelope encryption using versioned keys with separate key custody, shortest useful capability lifetimes, keyed API verifiers; dual-read/single-write rotation, rewrap then retire after backup window; access audited and restore/rotation drilled |
| SSRF and LAN pivot | Pinned node/storage destinations; isolate workers and Wings by egress policy, validate resolved IP on connection including IPv6, reject redirects unless fully revalidated; cap time/size; no arbitrary URL features without qualified controls |
| Malicious egg or mount / container escape | Admin-only egg install and mount review; validate image sources and host paths, allow-list mount roots; isolated disposable node for unknown images, no control-plane/network credentials in workloads |
| Injection and XSS | Parameterized SQL, strict schemas and CSP, output escaping, no raw log HTML, sanitize future markdown, fuzz paths and structured payloads |
| Destructive jobs / DoS | Hard budgets on polling and queues, idempotency and deduplication, confirmed destructive actions, audit, retry/backoff limits, fail closed on uncertain policy and maintenance state; automation off by default |
| Import compromise | Read-only snapshot, isolated secret handling and no side effects, validated archive/JSON/schema, verified backup/restore and quarantine of unknown data |
| Privacy leaks | Redact events at ingress and export, retention enforcement, role-scoped history, minimal future public projections; inspect fixtures for secret content |

Residual risks: daemon host compromise, imperfect log redaction, live JWT lifetime, irreversible post-cutover writes and legacy validators. Assign owners and document compensating controls before rollout. Stage 13 maps implemented controls to ASVS Level 2 verification evidence; this document is not certification.
