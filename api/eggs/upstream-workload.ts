import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { compileReviewedProfile } from "./runtime-profile";
import type { lifecycleFixture } from "../wings/lifecycle-fixture";

export const mumbleEgg = readFileSync(
  new URL("./upstream/egg-mumble-server.ptdl", import.meta.url),
  "utf8",
);
if (
  createHash("sha256").update(mumbleEgg).digest("hex") !==
  "af1f9e258fca2ce5077e03f36e2dbec5cacf07481a27e7a4230441fbca8bd4ca"
)
  throw new Error("Unreviewed upstream egg bytes");
export const mumbleMaxUsersPattern = "^[0-9]{1,5}(?![\\s\\S])";
export function upstreamWorkload(
  installed: Parameters<typeof lifecycleFixture>[0],
  server?: Parameters<typeof lifecycleFixture>[1],
  maxUsers?: string | null,
) {
  if (maxUsers != null && !new RegExp(mumbleMaxUsersPattern).test(maxUsers))
    throw new Error("Unsupported MAX_USERS");
  return compileReviewedProfile(
    mumbleEgg,
    installed,
    server,
    maxUsers == null ? {} : { MAX_USERS: maxUsers },
    { memory_limit: 256, disk_space: 128 },
  );
}

export const giteaEgg = readFileSync(
  new URL("./upstream/egg-gitea.ptdl", import.meta.url),
  "utf8",
);
if (
  createHash("sha256").update(giteaEgg).digest("hex") !==
  "4383426b6d93ff4d53d7ecd148ea82b1d75d2b6458f8786b16e3d611f2f222a5"
)
  throw new Error("Unreviewed Gitea egg bytes");
export function giteaWorkload(
  installed: Parameters<typeof lifecycleFixture>[0],
  server: NonNullable<Parameters<typeof lifecycleFixture>[1]>,
) {
  return compileReviewedProfile(
    giteaEgg,
    installed,
    server,
    { VERSION: "1.25.5", DISABLE_SSH: "true", SSH_PORT: "2020" },
    { memory_limit: 256, disk_space: 512 },
  );
}
