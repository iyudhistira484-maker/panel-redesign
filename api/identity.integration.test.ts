import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import { createApp, type ResetMessage } from "./app";
import { stagingPool, rows } from "./db";
import { migrate } from "./migrate";
import { totpAt } from "./security";

const enabled = process.env.RELAY_RUN_MYSQL_TESTS === "1";
test(
  "MySQL: migration, session rotation, 2FA, password reset and account isolation",
  { skip: !enabled },
  async () => {
    assert.match(
      process.env.RELAY_STAGING_DATABASE_URL ?? "",
      /\/relay_test$/,
      "Use the disposable relay_test database",
    );
    const pool = stagingPool();
    const origin = "https://relay.example.test";
    const deliveries: ResetMessage[] = [];
    const app = await createApp({
      pool,
      origin,
      key: randomBytes(32),
      pepper: randomBytes(32),
      deliverReset: async (message) => {
        deliveries.push(message);
      },
    });
    const request = (
      method: "GET" | "POST" | "DELETE" | "PATCH",
      path: string,
      body?: object,
      cookie?: string,
      authorization?: string,
    ) =>
      app.inject({
        method,
        url: `/api/v1/${path}`,
        headers: {
          origin,
          "x-relay-request": "1",
          ...(cookie ? { cookie } : {}),
          ...(authorization ? { authorization } : {}),
        },
        payload: body,
      });
    type Result = Awaited<ReturnType<typeof request>>;
    function ok(result: Result, status: number) {
      assert.equal(
        result.statusCode,
        status,
        `${status} expected: ${result.body}`,
      );
      return result;
    }
    function session(result: Result) {
      const cookie = result.cookies.find(
        (c) => c.name === "__Host-relay_session",
      );
      assert.ok(cookie?.secure && cookie.httpOnly);
      assert.equal(cookie.sameSite, "Strict");
      return `${cookie.name}=${cookie.value}`;
    }
    const pw = "fixture password for staging only";
    try {
      await migrate(pool, "up");
      await migrate(pool, "up");
      const alice = randomUUID(),
        bob = randomUUID();
      const old = (await bcrypt.hash(pw, 4)).replace(/^\$2b\$/, "$2y$");
      for (const [id, name] of [
        [alice, "alice"],
        [bob, "bob"],
      ])
        await pool.execute(
          "INSERT INTO users (id,email,display_name,password_hash) VALUES (?,?,?,?)",
          [id, `${name}@example.test`, name, old],
        );
      const login = (user: string, password = pw, cookie?: string) =>
        request(
          "POST",
          "auth/login",
          { email: `${user}@example.test`, password },
          cookie,
        );
      ok(await login("alice", "wrong"), 401);
      const first = session(ok(await login("alice"), 200));
      const a = session(ok(await login("alice", pw, first), 200));
      assert.notEqual(first, a);
      ok(await request("GET", "account", undefined, first), 401);
      const b = session(ok(await login("bob"), 200));
      assert.match(
        (
          await rows<{ password_hash: string }>(
            pool,
            "SELECT password_hash FROM users WHERE id=?",
            [alice],
          )
        )[0].password_hash,
        /^\$argon2id\$/,
      );
      ok(await request("PATCH", "account", { locale: "en" }, a), 204);
      const clientKey = `rly_${randomBytes(32).toString("base64url")}`;
      const key = ok(
        await request(
          "POST",
          "account/keys",
          { label: "fixture", key: clientKey },
          a,
        ),
        201,
      ).json<{ id: string; suffix: string }>();
      const bearer = `Bearer ${clientKey}.${key.suffix}`;
      assert.equal(
        ok(
          await request("GET", "account", undefined, undefined, bearer),
          200,
        ).json().id,
        alice,
      );
      ok(await request("DELETE", `account/keys/${key.id}`, undefined, b), 404);
      assert.deepEqual(
        ok(await request("GET", "account/keys", undefined, b), 200).json(),
        [],
      );
      ok(await request("DELETE", `account/keys/${key.id}`, undefined, a), 204);
      ok(await request("GET", "account", undefined, undefined, bearer), 401);
      const seed = randomBytes(20),
        recoveryCodes = Array.from({ length: 10 }, () =>
          randomBytes(12).toString("base64url"),
        );
      ok(
        await request(
          "POST",
          "account/totp/begin",
          { seed: seed.toString("base64url"), password: pw },
          a,
        ),
        204,
      );
      const confirmation = totpAt(seed, Math.floor(Date.now() / 30000));
      const enrolled = session(
        ok(
          await request(
            "POST",
            "account/totp/confirm",
            { code: confirmation, recoveryCodes },
            a,
          ),
          204,
        ),
      );
      ok(await request("GET", "account", undefined, a), 401);
      const pendingResult = ok(await login("alice"), 200);
      assert.equal(pendingResult.json().twoFactorRequired, true);
      const pending = session(pendingResult);
      ok(await request("GET", "account", undefined, pending), 401);
      ok(
        await request(
          "POST",
          "auth/challenge",
          { code: confirmation },
          pending,
        ),
        401,
      );
      const elevated = session(
        ok(
          await request(
            "POST",
            "auth/challenge",
            { code: recoveryCodes[0] },
            pending,
          ),
          200,
        ),
      );
      ok(await request("GET", "account", undefined, pending), 401);
      const pending2 = session(ok(await login("alice"), 200));
      ok(
        await request(
          "POST",
          "auth/challenge",
          { code: recoveryCodes[0] },
          pending2,
        ),
        401,
      );
      ok(
        await request("POST", "auth/forgot-password", {
          email: "missing@example.test",
        }),
        202,
      );
      ok(
        await request("POST", "auth/forgot-password", {
          email: "alice@example.test",
        }),
        202,
      );
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].locale, "en");
      const reset = {
        token: deliveries[0].token,
        password: "new staging fixture password",
      };
      ok(await request("POST", "auth/reset-password", reset), 204);
      ok(await request("POST", "auth/reset-password", reset), 400);
      for (const c of [enrolled, elevated, pending2])
        ok(await request("GET", "account", undefined, c), 401);
      ok(await login("alice"), 401);
      const fresh = session(ok(await login("alice", reset.password), 200));
      const step = Math.floor(Date.now() / 30000) + 1;
      const live = session(
        ok(
          await request(
            "POST",
            "auth/challenge",
            { code: totpAt(seed, step) },
            fresh,
          ),
          200,
        ),
      );
      assert.ok(
        ok(await request("GET", "account/activity", undefined, live), 200)
          .json()
          .some(
            (event: { event: string }) =>
              event.event === "identity.password_reset",
          ),
      );
      ok(await request("POST", "auth/logout", undefined, live), 204);
      ok(await request("GET", "account", undefined, live), 401);
      ok(await app.inject("/health/ready"), 200);
      await migrate(pool, "down");
      ok(await app.inject("/health/ready"), 503);
      await migrate(pool, "up");
      assert.deepEqual(await rows(pool, "SELECT id FROM users"), []);
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
