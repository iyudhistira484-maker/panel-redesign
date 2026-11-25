// Only installed on the disposable off-host fixture. No arbitrary paths or commands.
export const checkpointRecord = "checkpoint-record-v1";
export const startup = `#!/bin/sh
set -eu
cd /home/container
printf '%s\\n' RELAY_CONTRACT_READY
exec busybox-extras httpd -f -p "\${SERVER_PORT:?}" -h /home/container/relay-pilot-http
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
