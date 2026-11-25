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

export async function fixtureHttp(uuid: string, body?: string) {
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
        `http://${address}:25610/cgi-bin/record`,
      ],
      { timeout: 8000 },
    )
  ).stdout;
}

export async function observeHttpSwitch(
  uuid: string,
  expected: string,
  operation: () => Promise<void>,
) {
  let finished = false;
  let samples = 0;
  let failures = 0;
  const observe = async () => {
    do {
      const content = await fixtureHttp(uuid).catch(() => null);
      if (content !== expected) failures++;
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
  assert.equal(await fixtureHttp(uuid), expected);
  assert.equal(
    failures,
    0,
    "HTTP client observed interruption or unexpected data",
  );
  return { samples, switchMs: Math.round(performance.now() - started) };
}
