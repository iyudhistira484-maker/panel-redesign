# Production pilot: candidate intake and go/no-go

**Current decision: HOLD.** The single-workload HTTP staging rehearsal passed ([Foundation](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45830395433)). It does not qualify any real workload. No production host, server, or node is authorized by this document.

## Candidate selection (read-only)

Prefer a low-impact service with a reversible cutover, a known owner, observable health, and a backup that can be restored independently. Identify the Wings **node** as well as the workload: switching a Wings remote can affect every workload on that node. A one-workload pilot must use a dedicated node or have a separately validated isolation mechanism. Do not switch a shared node as a shortcut.

| Required input | Status |
| --- | --- |
| Candidate alias, workload type, criticality, node ownership and whether the node is shared | Unknown |
| Features in active use: primary/secondary ports, SFTP, schedules, subusers, databases, backups | Unknown |
| Actual API consumers and functions, or confirmation there are none | Unknown |
| Approximate volume bytes/file count, database type/size and backup/restore dependencies | Unknown |
| Probe path or client action, allowed downtime and data loss, maintenance window | Not agreed |
| Rollback owner and explicit approval for the named scope | Not granted |

Do not record passwords, API keys, private keys, production dumps or sensitive logs here. Do not collect them through chat.

## Go/no-go gates

1. **Scope:** Identify the node blast radius, every dependency and operation the candidate requires. Compare actual calls with the [integration inventory](integration-inventory.md); keep unsupported required functionality on HOLD.
2. **Recovery:** Restore a candidate-sized representative fixture in isolation using the [recovery runbook](pilot-runbook.md). Verify files, database consistency where applicable, and at least one read/write from a client. Agree recovery limits with the operator; staging timings are not production SLA values.
3. **Cutover and rollback:** Rehearse the same workload type in staging with an external health check where applicable and a write after cutover. Verify the write remains readable after rollback. Define a hard deadline for reverting and keep the original controller configuration available. Do not restore an old backup over post-cutover writes as a routine rollback.
4. **Approval:** Obtain explicit approval for the named node and workload, maintenance window, rollback triggers and backup. An operator self-run is useful but is not independent verification. Keep the legacy panel available during the pilot; decommissioning is a separate decision.

**Immediate rollback triggers to agree before execution:** lost or incorrect writes, failed authenticated health checks, unexpected impact beyond the candidate, or loss of reliable operator access. If rollback cannot preserve writes safely, stop further writes and escalate to the recovery procedure rather than improvising.

## Recommended first operator pilot

Choose a disposable stateful HTTP workload on a dedicated, non-production Wings node, with a single reversible record write and a known baseline. Use the [HTTP staging pilot](http-staging-pilot.md) as the workflow. Exclude voice, external bots, customer data, application databases and provisioning from this first scope. The existing `upcloudler` host is not a candidate because it already runs other services; the standalone Mumble container on Instabox is not a Wings workload. If Instabox is used as a separate staging host, first verify free disk, validate Docker/Wings and private access, and authorize that staging deployment separately. Until a named production workload and isolated node are identified, production remains HOLD.
