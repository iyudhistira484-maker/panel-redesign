import { mumbleEgg, upstreamWorkload } from "../eggs/upstream-workload";
import {
  reviewedHttpEggs,
  reviewedWorkload,
  type FixtureMode,
} from "../eggs/reviewed-workload";
import { lifecycleFixture } from "./lifecycle-fixture";
import { disposableEgg } from "./provision";
export const transferDocuments = [
  disposableEgg,
  reviewedHttpEggs[1],
  mumbleEgg,
].map((text) => Buffer.from(text));
export function transferProfile(document: Buffer) {
  if (document.equals(transferDocuments[0]))
    return {
      path: "relay-start.sh" as const,
      marker: "RELAY_CONTRACT_READY",
      workload: lifecycleFixture,
    };
  if (document.equals(transferDocuments[2]))
    return {
      path: "murmur.ini" as const,
      marker: "database",
      workload: (
        installed: Parameters<typeof lifecycleFixture>[0],
        server?: Parameters<typeof lifecycleFixture>[1],
        _mode?: FixtureMode | null,
        maxUsers?: string | null,
      ) => upstreamWorkload(installed, server, maxUsers),
    };
  if (document.equals(transferDocuments[1]))
    return {
      path: "site/index.html" as const,
      marker: "RELAY_REVIEWED_EGG_HTTP",
      workload: (
        installed: Parameters<typeof lifecycleFixture>[0],
        server?: Parameters<typeof lifecycleFixture>[1],
        mode?: FixtureMode | null,
      ) => reviewedWorkload(document, server, installed, mode),
    };
}
