import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { lifecycleFixture } from "../wings/lifecycle-fixture";

export const mumbleEgg = readFileSync(
  new URL("./upstream/egg-mumble-server.ptdl", import.meta.url),
  "utf8",
);
if (
  createHash("sha256").update(mumbleEgg).digest("hex") !==
  "af1f9e258fca2ce5077e03f36e2dbec5cacf07481a27e7a4230441fbca8bd4ca"
)
  throw new Error("Unreviewed upstream egg bytes");
const egg = JSON.parse(mumbleEgg);
export const mumbleMaxUsersPattern = "^[0-9]{1,5}(?![\\s\\S])";
export function upstreamWorkload(
  installed: Parameters<typeof lifecycleFixture>[0],
  server?: Parameters<typeof lifecycleFixture>[1],
  maxUsers?: string | null,
) {
  const base = lifecycleFixture(installed, server);
  const port = server?.port ?? 25610;
  const value = maxUsers ?? egg.variables[0].default_value;
  if (!new RegExp(mumbleMaxUsersPattern).test(value))
    throw new Error("Unsupported MAX_USERS");
  const ini = JSON.parse(egg.config.files)["murmur.ini"] as {
    parser: string;
    find: Record<string, string>;
  };
  return {
    ...base,
    configuration: {
      settings: {
        ...base.configuration.settings,
        invocation: egg.startup,
        environment: {
          ...(base.configuration.settings.environment as Record<
            string,
            string
          >),
          MAX_USERS: value,
        },
        container: { image: egg.docker_images.Mumble, requires_rebuild: false },
        build: {
          ...(base.configuration.settings.build as Record<string, unknown>),
          memory_limit: 256,
          disk_space: 128,
        },
      },
      process_configuration: {
        ...base.configuration.process_configuration,
        startup: {
          done: [JSON.parse(egg.config.startup).done],
          user_interaction: [],
          strip_ansi: false,
        },
        stop: { type: "signal", value: egg.config.stop.slice(1) },
        configs: [
          {
            file: "murmur.ini",
            parser: ini.parser,
            replace: Object.entries(ini.find).map(([match, replace_with]) => ({
              match,
              replace_with: replace_with
                .replace("{{server.build.default.port}}", String(port))
                .replace("{{server.build.env.MAX_USERS}}", value),
            })),
          },
        ],
      },
    },
    install: {
      container_image: egg.scripts.installation.container,
      entrypoint: egg.scripts.installation.entrypoint,
      script: egg.scripts.installation.script,
    },
  };
}
