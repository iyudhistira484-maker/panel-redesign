import assert from "node:assert/strict";
import { test } from "node:test";
import { readLegacySnapshot } from "./import/legacy-snapshot";

test("legacy reader rejects non-staging, remote, live, and option-bearing URLs before connecting", async () => {
  const previous = process.env.RELAY_ENV;
  try {
    process.env.RELAY_ENV = "production";
    await assert.rejects(
      readLegacySnapshot("mysql://u:p@127.0.0.1/panel_snapshot_ci"),
      /local staging/,
    );
    process.env.RELAY_ENV = "staging";
    for (const url of [
      "mysql://u:p@example.test/panel_snapshot_ci",
      "mysql://u:p@127.0.0.1/panel",
      "mysql://u:p@127.0.0.1/panel_snapshot_ci?multipleStatements=true",
    ]) {
      await assert.rejects(readLegacySnapshot(url), /local staging/);
    }
  } finally {
    if (previous === undefined) delete process.env.RELAY_ENV;
    else process.env.RELAY_ENV = previous;
  }
});
