import assert from "node:assert/strict";
import { test } from "node:test";
import { upstreamWorkload } from "./upstream-workload";

test("Mumble's validated limit maps to the environment and Wings INI rewrite", () => {
  const { settings, process_configuration } = upstreamWorkload(
    () => {},
    undefined,
    "37",
  ).configuration;
  assert.equal(
    (settings.environment as Record<string, string>).MAX_USERS,
    "37",
  );
  assert.deepEqual(
    process_configuration.configs[0].replace.find(
      ({ match }) => match === "users",
    ),
    { match: "users", replace_with: "37" },
  );
  for (const value of ["100000", "+25", "25\n", "1e2", ""]) {
    assert.throws(
      () => upstreamWorkload(() => {}, undefined, value),
      /Unsupported MAX_USERS/,
    );
  }
});
