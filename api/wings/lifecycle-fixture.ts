import { randomUUID } from "node:crypto";
import type { ContractWorkload } from "./remote";
export function lifecycleFixture(
  onResult: ContractWorkload["installed"],
  server: {
    uuid: string;
    port: number;
    name: string;
    eggId: string;
    diskMiB?: number;
    runtimeProfile?: "standard" | "diagnostic" | null;
  } = {
    uuid: randomUUID(),
    port: 25610,
    name: "Relay CI fixture",
    eggId: randomUUID(),
  },
): ContractWorkload {
  const { uuid, port, name, eggId } = server;
  const ip = "127.0.0.1";
  const diagnostic = server.runtimeProfile === "diagnostic";
  return {
    uuid,
    installed: onResult,
    configuration: {
      settings: {
        uuid,
        meta: { name, description: "Disposable" },
        suspended: false,
        environment: { SERVER_IP: ip, SERVER_PORT: String(port) },
        invocation: diagnostic
          ? "sh /home/container/relay-start.sh diagnostic"
          : "sh /home/container/relay-start.sh",
        skip_egg_scripts: false,
        build: {
          memory_limit: 128,
          swap: 0,
          io_weight: 500,
          cpu_limit: 50,
          disk_space: server.diskMiB ?? 64,
          oom_disabled: false,
        },
        container: {
          image: diagnostic
            ? "~relay-wings-contract-diagnostic:ci"
            : "~relay-wings-contract-workload:ci",
          requires_rebuild: false,
        },
        allocations: {
          force_outgoing_ip: false,
          default: { ip, port },
          mappings: { [ip]: [port] },
        },
        mounts: [],
        egg: { id: eggId, file_denylist: [] },
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
mkdir -p /mnt/server/fixture-docs
cat > /mnt/server/relay-start.sh <<'WORKLOAD'
#!/bin/sh
set -eu
trap 'exit 0' TERM INT
if [ "\${1:-}" = diagnostic ]; then printf '%s\n' RELAY_CONTRACT_PROFILE_DIAGNOSTIC; fi
printf '%s\n' RELAY_CONTRACT_READY
while :; do sleep 1 & wait "$!"; done
WORKLOAD
chmod 644 /mnt/server/relay-start.sh
`,
    },
  };
}
