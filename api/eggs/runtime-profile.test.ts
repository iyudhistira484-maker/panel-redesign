import assert from "node:assert/strict";
import { test } from "node:test";
import { compileReviewedProfile } from "./runtime-profile";
import { giteaEgg } from "./upstream-workload";

const compile = (document: string, vars: Record<string, string>) =>
  compileReviewedProfile(document, () => {}, undefined, vars, {
    memory_limit: 256,
    disk_space: 512,
  });
test("shared compiler validates range, enum, unknown variables and unsupported rules before compiling an installer", () => {
  assert.ok(
    compile(giteaEgg, {
      VERSION: "1.25.5",
      DISABLE_SSH: "true",
      SSH_PORT: "2020",
    }).install.script,
  );
  const invalid: Record<string, string>[] = [
    { SSH_PORT: "80" },
    { SSH_PORT: "70000" },
    { DISABLE_SSH: "yes" },
    { UNKNOWN: "x" },
    { VERSION: "a;id" },
  ];
  for (const vars of invalid) {
    assert.throws(() => compile(giteaEgg, vars), /Unsupported reviewed egg/);
  }
  assert.throws(
    () =>
      compile(
        giteaEgg.replace(
          "required|string|max:20",
          "required|string|regex:example",
        ),
        {},
      ),
    /Unsupported reviewed egg rule/,
  );
});
