import { parseEgg } from "./codec";
import { lifecycleFixture } from "../wings/lifecycle-fixture";
import type { ContractWorkload } from "../wings/remote";

export const fixtureModes = ["alpha", "beta"] as const;
export type FixtureMode = (typeof fixtureModes)[number];
const image = "~relay-wings-contract-http:ci";
const shared = {
  startup: `printf '%s\\n' "$RELAY_SITE_MODE" > /home/container/site/runtime.txt; echo RELAY_HTTP_START; /bin/busybox-extras httpd -f -p "$SERVER_PORT" -h /home/container/site & child=$!; trap 'kill "$child" 2>/dev/null || :; exit 0' TERM INT; wait "$child"`,
  config: {
    stop: "^SIGTERM",
    startup: '{"done":"RELAY_HTTP_START"}',
    files: JSON.stringify({
      "site/settings.json": {
        parser: "json",
        find: { mode: "{{server.build.env.RELAY_SITE_MODE}}" },
      },
    }),
    logs: "{}",
  },
  scripts: {
    installation: {
      container: "alpine:3.22.2",
      entrypoint: "sh",
      script:
        "#!/bin/sh\nset -eu\nmkdir -p /mnt/server/site\nprintf '%s\\n' RELAY_REVIEWED_EGG_HTTP > /mnt/server/site/index.html\nprintf '%s\\n' '{\"mode\":\"seed\",\"keep\":true}' > /mnt/server/site/settings.json\n",
    },
  },
  variables: [
    {
      name: "Site mode",
      env_variable: "RELAY_SITE_MODE",
      default_value: "alpha",
      user_viewable: true,
      user_editable: false,
      rules: "required|in:alpha,beta",
    },
  ],
};
/** Exact-byte staging allowlist, deliberately not a policy for arbitrary imported scripts. */
export const reviewedHttpEggs = [
  JSON.stringify({
    meta: { version: "PTDL_v1" },
    name: "Reviewed HTTP v1",
    images: [image],
    ...shared,
  }),
  JSON.stringify({
    meta: { version: "PTDL_v2" },
    name: "Reviewed HTTP v2",
    docker_images: { "BusyBox HTTP": image },
    ...shared,
  }),
] as const;

export function reviewedWorkload(
  document: Buffer,
  server: Parameters<typeof lifecycleFixture>[1],
  onInstall: ContractWorkload["installed"],
  mode?: FixtureMode | null,
) {
  const allowed = reviewedHttpEggs.find((text) =>
    document.equals(Buffer.from(text)),
  );
  if (!allowed) return undefined;
  const decoded = parseEgg(allowed);
  // Only the exact bytes above can reach this mapping.
  const egg = JSON.parse(decoded.source) as typeof shared;
  const value = mode ?? egg.variables[0].default_value;
  if (!fixtureModes.some((allowed) => allowed === value)) return undefined;
  const file = JSON.parse(egg.config.files)["site/settings.json"];
  const replacement = file.find.mode.replace(
    "{{server.build.env.RELAY_SITE_MODE}}",
    value,
  );
  const installation = egg.scripts.installation;
  const base = lifecycleFixture(onInstall, server);
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
          RELAY_SITE_MODE: value,
        },
        container: {
          image: Object.values(decoded.images)[0],
          requires_rebuild: false,
        },
      },
      process_configuration: {
        startup: {
          done: [JSON.parse(egg.config.startup).done],
          user_interaction: [],
          strip_ansi: false,
        },
        stop: { type: "signal", value: egg.config.stop.slice(1) },
        configs: [
          {
            file: "site/settings.json",
            parser: file.parser,
            replace: [{ match: "mode", replace_with: replacement }],
          },
        ],
      },
    },
    install: {
      container_image: installation.container,
      entrypoint: installation.entrypoint,
      script: installation.script,
    },
  } satisfies ContractWorkload;
}
