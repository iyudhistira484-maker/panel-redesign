// Only IDs representable as one safe URL path segment are admitted to staging.
export function isExternalServerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= 191 &&
    value !== "." &&
    value !== ".." &&
    value.trim() === value &&
    Buffer.from(value, "utf8").toString("utf8") === value &&
    !/[/\\\p{Cc}]/u.test(value)
  );
}
