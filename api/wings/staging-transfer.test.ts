import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseStagingTransfer } from "./staging-transfer";

test("staging transfer is disabled unless an exact role and disposable options are provided", () => {
  assert.equal(parseStagingTransfer({}), undefined);
  assert.equal(
    parseStagingTransfer({ RELAY_FIXTURE_TRANSFER_ROLE: "off" }),
    undefined,
  );
  const env = {
    RELAY_FIXTURE_TRANSFER_ROLE: "destination",
    RELAY_ENV: "staging",
    RELAY_ENABLE_DISPOSABLE_PROVISIONING: "1",
    RELAY_ENABLE_EMPTY_WINGS_TEST_NODE: "1",
    RELAY_ORIGIN: "https://relay.example.test",
    RELAY_FIXTURE_TRANSFER_SERVER: randomUUID(),
    RELAY_FIXTURE_TRANSFER_SOURCE: randomUUID(),
    RELAY_FIXTURE_TRANSFER_TARGET: randomUUID(),
    RELAY_FIXTURE_TRANSFER_ALLOCATION: randomUUID(),
  };
  assert.equal(parseStagingTransfer(env)?.role, "destination");
  assert.throws(() =>
    parseStagingTransfer({ ...env, RELAY_ENV: "production" }),
  );
  assert.throws(() =>
    parseStagingTransfer({
      ...env,
      RELAY_FIXTURE_TRANSFER_TARGET: env.RELAY_FIXTURE_TRANSFER_SOURCE,
    }),
  );
  assert.throws(() =>
    parseStagingTransfer({ ...env, RELAY_ENABLE_EMPTY_WINGS_TEST_NODE: "0" }),
  );
  assert.throws(() =>
    parseStagingTransfer({ ...env, RELAY_ORIGIN: "http://relay.example.test" }),
  );
});
