# Single-workload staging pilot: stateful HTTP

Run only on the disposable GitHub-hosted Foundation `legacy-panel` job. The candidate is the existing HTTP fixture behind Wings, with a primary and secondary TCP listener on the private Docker bridge. No real records, customer traffic, VPS configuration, or production credentials enter this run.

| Gate | Required evidence |
| --- | --- |
| Baseline | Both ports serve the same checkpoint under Pterodactyl; record the server/container identity, process start time and startup checksum. |
| Cutover | Relay takes over while keeping that workload running. At least two rounds of successful probes on both listeners, with zero observed failures and a switch budget of 30 seconds. |
| Normal operation | POST a new record through the secondary listener while Relay is authoritative. Both ports must return the new record. Exercise the bounded Nodeactyl inventory, resources, power and console contracts in the same legacy-panel job; power mutation checks are separate from the continuity window. |
| Rollback | Restore the original Wings controller configuration. Both ports must return the new record, with at least two successful probe rounds and a rollback budget of 30 seconds. Identity, start time and startup checksum must match across both switches. |

If a check fails, mark **HOLD**. Do not promote this run, overwrite the workload volume, or route traffic to production. The CI runner is disposable. Inspect the failing check before repeating. The probe cadence is not proof of zero downtime between samples, and the 30-second budgets are not production SLAs.

Excluded: real external bots, billing, suspend, unrestricted provisioning, public ports, voice quality, production rollback approval and decommission. The independent off-host recovery exercise has a separate [runbook](pilot-runbook.md); passing this pilot does not replace it.

## Fresh-runner recovery evidence

[Off-host recovery 45834345203](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45834345203) passed both checkpoint and restore at `d14644d`. The checkpoint job exercised the same two-port HTTP fixture (cutover 1.394 s, rollback 1.419 s, three rounds each, zero observed failures). A fresh runner restored 256 MiB / 2,048 files using independent runtime keys, read the HTTP checkpoint, wrote a new record and verified it after a controlled workload restart; it also reapplied access revocation. The restore measured 29.728 s, and checkpoint-to-simulated-loss measured 173 ms. The off-host client uses the primary HTTP port only. These timings are staging observations, not production RTO/RPO, and do not certify any production candidate.
