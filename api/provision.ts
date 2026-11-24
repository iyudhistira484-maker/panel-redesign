import { randomBytes } from "node:crypto";
import { base32 } from "./security";
const seed = randomBytes(20);
const mode = process.argv[2];
if (mode === "totp")
  console.log(
    JSON.stringify(
      {
        seed: seed.toString("base64url"),
        authenticatorKey: base32(seed),
        recoveryCodes: Array.from({ length: 10 }, () =>
          randomBytes(12).toString("base64url"),
        ),
      },
      null,
      2,
    ),
  );
else if (mode === "api-key")
  console.log(`rly_${randomBytes(32).toString("base64url")}`);
else {
  console.error("Use totp or api-key");
  process.exitCode = 1;
}
