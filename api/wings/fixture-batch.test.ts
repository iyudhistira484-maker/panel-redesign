import assert from "node:assert/strict";
import test from "node:test";
import { executeFixtureBatch } from "./fixture-batch";

test("batch continues past definite rejection but stops on an uncertain write", async () => {
  const items = Array.from({ length: 4 }, (_, index) => ({
    source: `${index}.bin`,
    target: `copy-${index}.bin`,
  }));
  const dispatched: string[] = [];
  const result = await executeFixtureBatch(
    items,
    async ({ source }) => {
      dispatched.push(source);
      if (source === "1.bin") throw new Error("file_exists");
      if (source === "2.bin") throw new Error("response lost");
    },
    (error) =>
      error instanceof Error && error.message === "file_exists"
        ? error.message
        : undefined,
  );
  assert.deepEqual(dispatched, ["0.bin", "1.bin", "2.bin"]);
  assert.deepEqual(result, {
    halted: true,
    results: [
      { ...items[0], status: "verified" },
      { ...items[1], status: "rejected", error: "file_exists" },
      { ...items[2], status: "unconfirmed" },
      { ...items[3], status: "not_attempted" },
    ],
  });
});
