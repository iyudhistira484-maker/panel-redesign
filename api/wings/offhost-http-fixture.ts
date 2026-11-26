// Only installed on the disposable off-host fixture. No arbitrary paths or commands.
export const checkpointRecord = "checkpoint-record-v1";
export const startup = `#!/bin/sh
set -eu
cd /home/container
printf '%s\\n' RELAY_CONTRACT_READY
busybox-extras httpd -f -p "\${SERVER_PORT:?}" -h /home/container/relay-pilot-http &
http_pid=$!
trap 'kill -TERM "$http_pid" 2>/dev/null || true; wait "$http_pid" || true; exit 0' TERM INT
wait "$http_pid"
`;
// Legacy adoption fixture owns exactly secondary TCP port 25616. The
// off-host workload retains the single-listener startup above.
export const adoptionStartup = `#!/bin/sh
set -eu
cd /home/container
busybox-extras httpd -f -p "\${SERVER_PORT:?}" -h /home/container/relay-pilot-http &
primary=$!
busybox-extras httpd -f -p 25616 -h /home/container/relay-pilot-http &
secondary=$!
trap 'kill -TERM "$primary" "$secondary" 2>/dev/null || true; wait "$primary" "$secondary" || true' EXIT
trap 'exit 0' TERM INT
printf '%s\\n' RELAY_CONTRACT_READY
wait "$primary"
`;
export const recordCgi = `#!/bin/sh
set -eu
cd /home/container/relay-pilot-http
case "$REQUEST_METHOD" in
  GET) ;;
  POST)
    case "\${CONTENT_LENGTH:-}" in ''|*[!0-9]*) exit 1 ;; esac
    test "$CONTENT_LENGTH" -ge 1 && test "$CONTENT_LENGTH" -le 64 || exit 1
    tmp=$(mktemp ./record.XXXXXX)
    trap 'rm -f "$tmp"' EXIT
    dd bs=1 count="$CONTENT_LENGTH" of="$tmp" 2>/dev/null
    test "$(wc -c < "$tmp")" -eq "$CONTENT_LENGTH"
    mv -f "$tmp" record.txt
    ;;
  *) printf 'Status: 405 Method Not Allowed\\r\\n\\r\\n'; exit 0 ;;
esac
printf 'Content-Type: text/plain\\r\\nCache-Control: no-store\\r\\n\\r\\n'
cat record.txt
`;

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const docker = promisify(execFile);

type FixtureHttpPort = 25610 | 25616;
export async function fixtureHttp(
  uuid: string,
  body?: string,
  port: FixtureHttpPort = 25610,
) {
  assert.match(uuid, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.ok(port === 25610 || port === 25616);
  const address = (
    await docker(
      "docker",
      [
        "inspect",
        "--format",
        '{{(index .NetworkSettings.Networks "relay-wings-contract-net").IPAddress}}',
        uuid,
      ],
      { timeout: 5000 },
    )
  ).stdout.trim();
  assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
  return (
    await docker(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "relay-wings-contract-net",
        "--entrypoint",
        "busybox",
        "relay-wings-contract-workload:ci",
        "wget",
        "-T",
        "2",
        "-qO-",
        ...(body === undefined ? [] : ["--post-data", body]),
        `http://${address}:${port}/cgi-bin/record`,
      ],
      { timeout: 8000 },
    )
  ).stdout;
}

export async function observeHttpSwitch(
  uuid: string,
  expected: string,
  operation: () => Promise<void>,
  ports: readonly FixtureHttpPort[] = [25610],
) {
  assert.ok(ports.length > 0 && new Set(ports).size === ports.length);
  let finished = false;
  let samples = 0;
  let failures = 0;
  const probeAll = () =>
    Promise.all(
      ports.map((port) => fixtureHttp(uuid, undefined, port).catch(() => null)),
    );
  const observe = async () => {
    do {
      const observed = await probeAll();
      failures += observed.filter((value) => value !== expected).length;
      samples++;
      if (!finished) await new Promise((resolve) => setTimeout(resolve, 200));
    } while (!finished);
  };
  const started = performance.now();
  const probe = observe();
  try {
    await operation();
  } finally {
    finished = true;
    await probe;
  }
  assert.deepEqual(
    await probeAll(),
    ports.map(() => expected),
  );
  assert.equal(
    failures,
    0,
    "HTTP client observed interruption or unexpected data",
  );
  return {
    samples,
    ports: ports.length,
    switchMs: Math.round(performance.now() - started),
  };
}
