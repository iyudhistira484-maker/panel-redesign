import { readLegacySnapshot } from "./legacy-snapshot";

async function main() {
  try {
    const { report } = await readLegacySnapshot(
      process.env.RELAY_LEGACY_SNAPSHOT_URL ?? "",
    );
    console.log(JSON.stringify({ mode: "read-only", counts: report.counts }));
  } catch {
    console.error(
      "Panel snapshot preflight failed. Check the local copy, SELECT-only access, and supported schema.",
    );
    process.exitCode = 1;
  }
}
void main();
