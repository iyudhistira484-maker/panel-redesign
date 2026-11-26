import assert from "node:assert/strict";
import test from "node:test";
import { observeMumbleSessions } from "./mumble-fixture-client";

test("samples both original sessions around the operation", async () => {
  const calls = [0, 0];
  const sessions = calls.map((_, index) => ({
    probe: async () => {
      calls[index]++;
    },
  }));
  const result = await observeMumbleSessions(sessions, async () => {
    assert.ok(calls.every((count) => count >= 2));
  });
  assert.ok(result.samples >= 1);
  assert.ok(calls.every((count) => count >= 3));
});

test("fails when a session drops even if the operation succeeds", async () => {
  let count = 0;
  const connected = { probe: async () => {} };
  const dropped = {
    probe: async () => {
      if (++count === 2) throw new Error("original session dropped");
    },
  };
  await assert.rejects(
    observeMumbleSessions([connected, dropped], async () => {}),
    /original session dropped/,
  );
});
