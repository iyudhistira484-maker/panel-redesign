export type FixtureBatchItem = { source: string; target: string };
export type FixtureBatchStatus =
  | "verified"
  | "rejected"
  | "unconfirmed"
  | "not_attempted";

export type FixtureBatchResult = FixtureBatchItem & {
  status: FixtureBatchStatus;
  error?: string;
};

export async function executeFixtureBatch(
  items: FixtureBatchItem[],
  execute: (item: FixtureBatchItem) => Promise<unknown>,
  knownRejection: (error: unknown) => string | undefined,
  persist?: (index: number, result: FixtureBatchResult) => Promise<void>,
) {
  let halted = false;
  const results: FixtureBatchResult[] = [];
  for (const item of items) {
    if (halted) {
      results.push({ ...item, status: "not_attempted" });
      continue;
    }
    try {
      await execute(item);
      results.push({ ...item, status: "verified" });
    } catch (error) {
      const code = knownRejection(error);
      if (code) results.push({ ...item, status: "rejected", error: code });
      else {
        halted = true;
        results.push({ ...item, status: "unconfirmed" });
      }
    }
    await persist?.(results.length - 1, results[results.length - 1]);
  }
  return { results, halted };
}
