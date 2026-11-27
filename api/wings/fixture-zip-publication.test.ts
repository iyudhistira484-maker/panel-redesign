import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WingsClient, WingsUnavailable } from "./client";

const suffix = "a".repeat(32);
const pending = `zip-pending-${suffix}`;
const destination = `extract-${suffix}`;
const entries = [
  { name: "one.txt", bytes: Buffer.from("first") },
  { name: "two.txt", bytes: Buffer.from("second") },
];
function fixture(fault: "second-write" | "delete" | "rename-response") {
  const dirs = new Map<string, Map<string, Buffer>>();
  let reconnect = false;
  const calls: string[] = [];
  class Client extends WingsClient {
    override async fixtureUploadTargetExists(_id: string, name: string) {
      return dirs.has(name);
    }
    override async fixtureDownload(_id: string, path: string[], name: string) {
      const bytes = dirs.get(path[1])?.get(name);
      assert.ok(bytes);
      return bytes;
    }
  }
  const client = new Client(
    {
      origin: "http://127.0.0.1:18080",
      tokenId: "ziptestnode",
      token: "abcdefghijklmnopqrstuvwxyz0123456789",
    },
    async (input, init) => {
      const url = new URL(String(input));
      const action = url.pathname.split("/").at(-1);
      calls.push(String(action));
      if (action === "create-directory")
        dirs.set(JSON.parse(String(init?.body)).name, new Map());
      else if (action === "write") {
        const [, , folder, name] = String(url.searchParams.get("file")).split(
          "/",
        );
        if (!reconnect && name === "two.txt" && fault !== "rename-response")
          throw new TypeError("connection lost");
        dirs.get(folder)?.set(name, Buffer.from(String(init?.body)));
      } else if (action === "delete") {
        if (fault === "delete") throw new TypeError("still disconnected");
        dirs.delete(JSON.parse(String(init?.body)).files[0]);
      } else if (action === "rename") {
        const [{ from, to }] = JSON.parse(String(init?.body)).files;
        const staged = dirs.get(from);
        assert.ok(staged);
        assert.equal(staged.size, entries.length);
        dirs.set(to, staged);
        dirs.delete(from);
        throw new TypeError("rename response lost");
      } else assert.fail(`unexpected ${action}`);
      return new Response(null, { status: 204 });
    },
  );
  return {
    dirs,
    calls,
    client,
    connect: () => {
      reconnect = true;
    },
  };
}
const unverified = (error: unknown) =>
  error instanceof WingsUnavailable && error.reason === "transport";
test("lost second write never publishes partial ZIP and cleans staging when reachable", async () => {
  const { dirs, calls, client } = fixture("second-write");
  await assert.rejects(
    client.publishFixtureZip(randomUUID(), suffix, entries),
    unverified,
  );
  assert.deepEqual(calls, ["create-directory", "write", "write", "delete"]);
  assert.equal(dirs.size, 0);
});
test("persistent outage leaves only pending data and a repeat cannot overwrite it", async () => {
  const { dirs, calls, client, connect } = fixture("delete");
  const id = randomUUID();
  await assert.rejects(
    client.publishFixtureZip(id, suffix, entries),
    unverified,
  );
  assert.equal(dirs.has(destination), false);
  assert.deepEqual([...(dirs.get(pending)?.keys() ?? [])], ["one.txt"]);
  connect();
  const before = [...calls];
  await assert.rejects(
    client.publishFixtureZip(id, suffix, entries),
    WingsUnavailable,
  );
  assert.deepEqual(calls, before);
});
test("lost rename response preserves already-published complete results", async () => {
  const { dirs, calls, client } = fixture("rename-response");
  await assert.rejects(
    client.publishFixtureZip(randomUUID(), suffix, entries),
    unverified,
  );
  assert.equal(dirs.has(pending), false);
  assert.deepEqual(
    dirs.get(destination),
    new Map(entries.map(({ name, bytes }) => [name, bytes])),
  );
  assert.equal(calls.includes("delete"), false);
});
