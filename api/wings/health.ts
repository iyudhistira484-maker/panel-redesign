import { WingsClient } from "./client";
async function main() {
  if (
    process.env.RELAY_ENV !== "staging" ||
    process.env.RELAY_ENABLE_EMPTY_WINGS_TEST_NODE !== "1"
  )
    throw new Error("Qualification disabled");
  const client = new WingsClient({
    origin: process.env.RELAY_WINGS_TEST_ORIGIN ?? "",
    tokenId: process.env.RELAY_WINGS_TEST_TOKEN_ID ?? "",
    token: process.env.RELAY_WINGS_TEST_TOKEN ?? "",
  });
  console.log(JSON.stringify(await client.health()));
}
void main().catch(() => {
  console.error("Wings staging health check failed");
  process.exitCode = 1;
});
