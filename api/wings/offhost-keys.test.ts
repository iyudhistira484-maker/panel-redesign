import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { offhostKey } from "./offhost-keys";

test("disposable runtime keys are stable across runners, separated by run and purpose", () => {
  Object.assign(process.env, {
    RELAY_OFFHOST_RUNTIME_SEED: randomBytes(32).toString("hex"),
    GITHUB_WORKFLOW: "Relay Wings off-host staging",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "123",
  });
  const key = offhostKey("identity");
  assert.equal(key?.length, 32);
  assert.deepEqual(key, offhostKey("identity"));
  assert.notDeepEqual(key, offhostKey("pepper"));
  process.env.GITHUB_RUN_ID = "124";
  assert.notDeepEqual(key, offhostKey("identity"));
  process.env.GITHUB_EVENT_NAME = "push";
  assert.throws(
    () => offhostKey("identity"),
    /Invalid disposable runtime seed/,
  );
  delete process.env.RELAY_OFFHOST_RUNTIME_SEED;
  assert.equal(offhostKey("identity"), undefined);
});
