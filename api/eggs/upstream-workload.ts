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

export const giteaEgg = readFileSync(
  new URL("./upstream/egg-gitea.ptdl", import.meta.url),
  "utf8",
);
if (
  createHash("sha256").update(giteaEgg).digest("hex") !==
  "4383426b6d93ff4d53d7ecd148ea82b1d75d2b6458f8786b16e3d611f2f222a5"
)
  throw new Error("Unreviewed Gitea egg bytes");
const gitea = JSON.parse(giteaEgg);
export function giteaWorkload(
  installed: Parameters<typeof lifecycleFixture>[0],
  server: NonNullable<Parameters<typeof lifecycleFixture>[1]>,
) {
  const base = lifecycleFixture(installed, server);
  const environment = {
    ...(base.configuration.settings.environment as Record<string, string>),
    VERSION: "1.25.5",
    DISABLE_SSH: "true",
    SSH_PORT: "2020",
  };
  const rules = JSON.parse(gitea.config.files)["custom/app.ini"].find as Record<
    string,
    string
  >;
  return {
    ...base,
    configuration: {
      settings: {
        ...base.configuration.settings,
        environment,
        invocation: gitea.startup,
        container: {
          image: Object.values(gitea.docker_images)[0],
          requires_rebuild: false,
        },
        build: {
          ...(base.configuration.settings.build as Record<string, unknown>),
          memory_limit: 256,
          disk_space: 512,
        },
      },
      process_configuration: {
        ...base.configuration.process_configuration,
        startup: {
          done: [JSON.parse(gitea.config.startup).done],
          user_interaction: [],
          strip_ansi: false,
        },
        stop: { type: "signal", value: "SIGINT" },
        configs: [
          {
            file: "custom/app.ini",
            parser: "file",
            replace: Object.entries(rules).map(([match, value]) => ({
              match,
              replace_with: value
                .replace(
                  "{{server.build.env.DISABLE_SSH}}",
                  environment.DISABLE_SSH,
                )
                .replace("{{server.build.env.SSH_PORT}}", environment.SSH_PORT),
            })),
          },
        ],
      },
    },
    install: {
      script: gitea.scripts.installation.script,
      entrypoint: gitea.scripts.installation.entrypoint,
      container_image: gitea.scripts.installation.container,
    },
  };
}
