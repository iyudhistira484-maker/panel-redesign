import { randomUUID } from "node:crypto";
import type { ContractWorkload } from "./remote";
export function lifecycleFixture(
  onResult: ContractWorkload["installed"],
): ContractWorkload {
  const uuid = randomUUID();
  const ip = "127.0.0.1";
  const port = 25610;
  return {
    uuid,
    installed: onResult,
    configuration: {
      settings: {
        uuid,
        meta: { name: "Relay CI fixture", description: "Disposable" },
        suspended: false,
        environment: { SERVER_IP: ip, SERVER_PORT: String(port) },
        invocation: "sh /home/container/relay-start.sh",
        skip_egg_scripts: false,
        build: {
          memory_limit: 128,
          swap: 0,
          io_weight: 500,
          cpu_limit: 50,
          disk_space: 64,
          oom_disabled: false,
        },
        container: {
          image: "~relay-wings-contract-workload:ci",
          requires_rebuild: false,
        },
        allocations: {
          force_outgoing_ip: false,
          default: { ip, port },
          mappings: { [ip]: [port] },
        },
        mounts: [],
        egg: { id: randomUUID(), file_denylist: [] },
      },
      process_configuration: {
        startup: {
          done: ["RELAY_CONTRACT_READY"],
          user_interaction: [],
          strip_ansi: false,
        },
        stop: { type: "signal", value: "SIGTERM" },
        configs: [],
      },
    },
    install: {
      container_image: "alpine:3.22.2",
      entrypoint: "sh",
      script: `#!/bin/sh
set -eu
cat > /mnt/server/relay-start.sh <<'WORKLOAD'
#!/bin/sh
set -eu
trap 'exit 0' TERM INT
printf '%s\n' RELAY_CONTRACT_READY
while :; do sleep 1 & wait "$!"; done
WORKLOAD
chmod 644 /mnt/server/relay-start.sh
`,
    },
  };
}
