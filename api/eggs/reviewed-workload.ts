import { parseEgg } from "./codec";
import { lifecycleFixture } from "../wings/lifecycle-fixture";
import type { ContractWorkload } from "../wings/remote";

const image = "~relay-wings-contract-http:ci";
const shared = {
  startup:
    'echo RELAY_HTTP_START; exec busybox httpd -f -p "$SERVER_PORT" -h /home/container/site',
  config: {
    stop: "^SIGTERM",
    startup: '{"done":"RELAY_HTTP_START"}',
    files: "{}",
    logs: "{}",
  },
  scripts: {
    installation: {
      container: "alpine:3.22.2",
      entrypoint: "sh",
      script:
        "#!/bin/sh\nset -eu\nmkdir -p /mnt/server/site\nprintf '%s\\n' RELAY_REVIEWED_EGG_HTTP > /mnt/server/site/index.html\n",
    },
  },
  variables: [],
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
) {
  const allowed = reviewedHttpEggs.find((text) =>
    document.equals(Buffer.from(text)),
  );
  if (!allowed) return undefined;
  const decoded = parseEgg(allowed);
  // Only the exact bytes above can reach this mapping.
  const egg = JSON.parse(decoded.source) as typeof shared;
  const installation = egg.scripts.installation;
  const base = lifecycleFixture(onInstall, server);
  return {
    ...base,
    configuration: {
      settings: {
        ...base.configuration.settings,
        invocation: egg.startup,
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
        configs: [],
      },
    },
    install: {
      container_image: installation.container,
      entrypoint: installation.entrypoint,
      script: installation.script,
    },
  } satisfies ContractWorkload;
}
