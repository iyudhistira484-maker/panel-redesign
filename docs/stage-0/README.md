# Stage 0 — discovery and architecture

**Review requested; Stage 1 has not started.** Baselines: [Panel v1.15.2 source](https://github.com/pterodactyl/panel/tree/90b2aa87469da4fffd941b3c99f3c1ca48a01b78) and [Wings v1.13.5 source](https://github.com/pterodactyl/wings/tree/3236480d078c09b823b8a8f21dab76c4029608a5). These are peeled commit IDs, not annotated tag object IDs. They are a discovery baseline, not a supported source-version matrix. The working checkout only contains project documentation; upstream clones were outside it.

| Deliverable | File(s) | Verification |
|---|---|---|
| Schema, import, cutover and rollback | [data.md](data.md) | Source baseline; actual copy and APP_KEY not inspected, backup not confirmed |
| Wings protocol | [wings.md](wings.md) | Source-reviewed; payload-level and real Docker validation outstanding |
| Legacy public APIs | [Client](api-client.md), [Application](api-application.md) | Route declarations inventoried; serializer and integration tests pending |
| Permissions, eggs, feature audit | [permissions.md](permissions.md), [eggs.md](eggs.md), [parity.md](parity.md) | Source catalog; runtime acceptance unchecked |
| Stack and decisions | [architecture.md](architecture.md), [ADRs](adr/) | Proposed, not accepted |
| Threat model | [threat-model.md](threat-model.md) | Documented; controls not implemented |
| Tests and CI | [testing.md](testing.md) | Planned; Docker CLI/socket absent, no runtime tests |
| Notices | [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) | Upstream notices retained |

Root README was updated to link this report. Nothing to start or deploy. To review, open the linked Markdown files and run `git diff --check`; compare the inventories with the pinned source paths. No migrations were run and no production panel, database or node was contacted. No automation, mock UI, compatibility layer, import tool or test suite was built.

## Decisions needed

1. Approve Stage 0 or request revisions. Which stack and primary SQL engine/version should Stage 1 target?
2. What Panel, Wings, SQL and PHP versions exist in the intended migration fleet? Any forks, plugins, external database hosts, nonstandard mounts or S3 providers? No credentials in chat.
3. Can you provide a disposable Linux Docker staging environment with two test nodes for transfers, and separately confirm the backup and authorized data-copy process before Stage 10? Who holds the APP_KEY and restores backups? Do not share secrets here.
4. Which bots/billing clients must run unchanged? Approve the compatibility scope or name required endpoints and test integrations. Decide how to handle parity features that require presenting newly issued or existing connection secrets versus the no-full-secret API rule.
5. Should upstream-equivalent v2 export suffice, or is explicit v1 export required with refusal for nonrepresentable eggs? Who approves Indonesian terminology, public product placeholder and cutover RPO/RTO?
