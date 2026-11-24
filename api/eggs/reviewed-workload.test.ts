import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewedHttpEggs, reviewedWorkload } from "./reviewed-workload";

test("approved v1/v2 HTTP egg bytes map to identical safe workload settings", () => {
  const first = reviewedWorkload(
    Buffer.from(reviewedHttpEggs[0]),
    undefined,
    () => {},
  );
  const second = reviewedWorkload(
    Buffer.from(reviewedHttpEggs[1]),
    undefined,
    () => {},
  );
  assert.ok(first && second);
  assert.deepEqual(first.install, second.install);
  assert.equal(
    first.configuration.settings.invocation,
    second.configuration.settings.invocation,
  );
  assert.deepEqual(
    first.configuration.process_configuration,
    second.configuration.process_configuration,
  );
  for (const text of reviewedHttpEggs) {
    assert.equal(
      reviewedWorkload(Buffer.from(`${text}\n`), undefined, () => {}),
      undefined,
    );
    assert.equal(
      reviewedWorkload(
        Buffer.from(text.replace("RELAY_HTTP_START", "UNREVIEWED")),
        undefined,
        () => {},
      ),
      undefined,
    );
  }
});
