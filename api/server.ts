import {
  loadStagingTransfer,
  parseStagingTransfer,
} from "./wings/staging-transfer";
import { stagingMail } from "./staging-mail";
import { createApp } from "./app";
import { stagingPool } from "./db";
import { keyFrom } from "./security";

async function main() {
  const origin = process.env.RELAY_ORIGIN ?? "";
  const key = keyFrom(process.env.RELAY_TOTP_KEY, "RELAY_TOTP_KEY");
  const pepper = keyFrom(process.env.RELAY_TOKEN_PEPPER, "RELAY_TOKEN_PEPPER");
  const port = Number(process.env.RELAY_API_PORT ?? 3200);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid port");
  const pool = stagingPool();
  const mail = stagingMail(origin);
  const wingsTestNode =
    process.env.RELAY_ENABLE_EMPTY_WINGS_TEST_NODE === "1"
      ? {
          origin: process.env.RELAY_WINGS_TEST_ORIGIN ?? "",
          tokenId: process.env.RELAY_WINGS_TEST_TOKEN_ID ?? "",
          token: process.env.RELAY_WINGS_TEST_TOKEN ?? "",
        }
      : undefined;
  const catalogNodeKey = process.env.RELAY_NODE_KEY
    ? keyFrom(process.env.RELAY_NODE_KEY, "RELAY_NODE_KEY")
    : undefined;
  const transfer = await loadStagingTransfer(
    pool,
    parseStagingTransfer(process.env),
    wingsTestNode,
    catalogNodeKey,
    pepper,
  );
  const app = await createApp({
    wingsTestNode,
    enableDisposableProvisioning:
      process.env.RELAY_ENABLE_DISPOSABLE_PROVISIONING === "1",
    catalogNodeKey,
    ...transfer,
    allowedCatalogNodeOrigins: process.env.RELAY_CATALOG_NODE_ORIGIN
      ? [process.env.RELAY_CATALOG_NODE_ORIGIN]
      : [],
    pool,
    origin,
    key,
    pepper,
    deliverReset: mail.deliverReset,
  });
  app.addHook("onClose", async () => {
    mail.close();
    await pool.end();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  await app.listen({ host: "127.0.0.1", port });
  console.log("Relay staging identity API ready");
}
void main().catch(() => {
  console.error("Staging API cannot start. Check the configuration.");
  process.exit(1);
});
