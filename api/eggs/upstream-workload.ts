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

type Approval = {
  name: string;
  file: string;
  sha256: string;
  executable: string;
  overrides: Record<string, string>;
  resources: { memory_limit: number; disk_space: number };
};
const approvals = JSON.parse(
  readFileSync(new URL("./upstream/approved.json", import.meta.url), "utf8"),
) as Approval[];
export const upstreamProfiles = approvals.map((row) => {
  if (
    !/^egg-[a-z0-9-]+\.ptdl$/.test(row.file) ||
    !/^[-a-z0-9]+$/.test(row.executable)
  )
    throw new Error("Invalid approved profile paths");
  const document = readFileSync(
    new URL(`./upstream/${row.file}`, import.meta.url),
    "utf8",
  );
  if (createHash("sha256").update(document).digest("hex") !== row.sha256)
    throw new Error("Unreviewed upstream egg bytes");
  return { ...row, document };
});
export const giteaEgg = upstreamProfiles[0].document;
export function registeredWorkload(
  profile: (typeof upstreamProfiles)[number],
  installed: Parameters<typeof lifecycleFixture>[0],
  server: NonNullable<Parameters<typeof lifecycleFixture>[1]>,
) {
  const profileConfig = compileReviewedProfile(
    profile.document,
    installed,
    server,
    profile.overrides,
    profile.resources,
  );
  if (profile.file === "egg-gitea.ptdl") {
    return {
      ...profileConfig,
      install: {
        ...profileConfig.install,
        script: readFileSync(
          new URL("./upstream/install-gitea-staging.sh", import.meta.url),
          "utf8",
        ),
      },
    };
  }
  return profileConfig;
}
