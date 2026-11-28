import { defineConfig } from "vite";

// Browser traffic stays same-origin. Enable only alongside a local staging API
// configured with the exact browser origin; do not rewrite the CSRF Origin.
const proxy = process.env.RELAY_DEV_API_PROXY === "1"
  ? { "/api/v1/auth": { target: "http://127.0.0.1:3200" }, "/api/v1/account": { target: "http://127.0.0.1:3200" }, "/api/v1/servers": { target: "http://127.0.0.1:3200" } }
  : undefined;
const codespace = process.env.CODESPACE_NAME ?? "";
const forwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
const allowedHosts = [".e2b.app"];
if (process.env.CODESPACES === "true" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(codespace) && forwardingDomain === "app.github.dev") {
  allowedHosts.push(`${codespace}-5173.${forwardingDomain}`);
}
export default defineConfig({build:{minify:"terser"},define:{__RELAY_AUTHENTICATED_ENTRY__:JSON.stringify(process.env.RELAY_AUTHENTICATED_ENTRY === "1")},server:{host:"0.0.0.0",port:5173,strictPort:process.env.CODESPACES === "true",allowedHosts,proxy},preview:{proxy}});
