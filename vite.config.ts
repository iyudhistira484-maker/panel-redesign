import { defineConfig } from "vite";

// Browser traffic stays same-origin. Enable only alongside a local staging API
// configured with the exact browser origin; do not rewrite the CSRF Origin.
const proxy = process.env.RELAY_DEV_API_PROXY === "1"
  ? { "/api/v1/auth": { target: "http://127.0.0.1:3200" }, "/api/v1/account": { target: "http://127.0.0.1:3200" } }
  : undefined;
export default defineConfig({server:{host:"0.0.0.0",allowedHosts:[".e2b.app"],proxy},preview:{proxy}});
