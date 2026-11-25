#!/usr/bin/env bash
set -euo pipefail
[[ "${RELAY_ENV:-}" == staging && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${RELAY_STAGING_DATABASE_URL:-}" == */relay_test ]]
work=$(mktemp -d)
api_pid=''
proxy_pid=''
cleanup() {
  if [[ -n "$proxy_pid" ]]; then kill "$proxy_pid" 2>/dev/null || true; fi
  if [[ -n "$api_pid" ]]; then kill "$api_pid" 2>/dev/null || true; fi
  docker rm -f relay-browser-mailpit >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT
export RELAY_ORIGIN=https://127.0.0.1:4443
export RELAY_TOTP_KEY=$(openssl rand -base64 32)
export RELAY_TOKEN_PEPPER=$(openssl rand -base64 32)
export RELAY_BROWSER_AUTH_CI=1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -addext 'subjectAltName=IP:127.0.0.1' -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
docker run -d --name relay-browser-mailpit -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 axllent/mailpit:v1.27.11 >/dev/null
npm run db -- up
node --import tsx api/server.ts &
api_pid=$!
node scripts/auth-browser-proxy.mjs "$work/cert.pem" "$work/key.pem" &
proxy_pid=$!
curl --silent --show-error --fail --retry 12 --retry-all-errors --retry-delay 1 http://127.0.0.1:3200/health/ready >/dev/null
npx playwright test tests/browser-auth-live.spec.ts --reporter=line,github
