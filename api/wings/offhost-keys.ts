import { createHmac } from "node:crypto";

// Disposable rehearsal only. Production should recover its original keys from a vault.
export function offhostKey(label: string) {
  const seed = process.env.RELAY_OFFHOST_RUNTIME_SEED;
  if (!seed) return undefined;
  if (
    process.env.GITHUB_WORKFLOW !== "Relay Wings off-host staging" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !/^[a-f0-9]{64}$/.test(seed) ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
  )
    throw new Error("Invalid disposable runtime seed configuration");
  return createHmac("sha256", Buffer.from(seed, "hex"))
    .update(`relay-offhost-ci:v1:${process.env.GITHUB_RUN_ID}:${label}`)
    .digest();
}
