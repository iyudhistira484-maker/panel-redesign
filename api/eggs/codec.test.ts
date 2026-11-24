import { test } from "node:test";
import assert from "node:assert/strict";
import { exportEgg, parseEgg } from "./codec";
const fixture = {
  meta: { version: "PTDL_v1", update_url: null },
  name: "Relay Example",
  image: "example/runtime:1",
  startup: "node index.js",
  config: {
    files: '{ "test.properties": {"parser":"properties"} }',
    startup: '{"done":"ready"}',
    stop: "stop",
  },
  scripts: {
    installation: {
      script: "#!/bin/sh\nprintf ready",
      entrypoint: "sh",
      container: "alpine:3.22.2",
    },
  },
  variables: [
    {
      env_variable: "PREFIX",
      rules: "required|regex:/^(a|b)$/",
      default_value: "a",
      user_viewable: false,
    },
  ],
};
test("same-version export preserves the original bytes; conversion preserves opaque rules and scripts", () => {
  const text = `${JSON.stringify(fixture, null, 4)}\n`;
  const parsed = parseEgg(text);
  assert.equal(exportEgg(parsed), text);
  const v2 = parseEgg(exportEgg(parsed, "PTDL_v2"));
  assert.deepEqual(v2.images, { "example/runtime:1": "example/runtime:1" });
  assert.deepEqual(v2.variables, parsed.variables);
  assert.deepEqual(JSON.parse(v2.source).scripts, fixture.scripts);
  assert.deepEqual(parseEgg(exportEgg(v2, "PTDL_v1")).images, parsed.images);
});
test("invalid version, duplicate variable and lossy image-label conversion are rejected", () => {
  assert.throws(
    () =>
      parseEgg(JSON.stringify({ ...fixture, meta: { version: "unknown" } })),
    { field: "meta.version" },
  );
  assert.throws(
    () =>
      parseEgg(
        JSON.stringify({
          ...fixture,
          variables: [...fixture.variables, ...fixture.variables],
        }),
      ),
    { field: "variables.env_variable" },
  );
  const v2 = parseEgg(
    JSON.stringify({
      ...fixture,
      meta: { version: "PTDL_v2" },
      docker_images: { Example: "example/runtime:1" },
    }),
  );
  assert.throws(() => exportEgg(v2, "PTDL_v1"), /lose image labels/);
});
