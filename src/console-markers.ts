// Reviewed, constant fixture messages only. Never match variable suffixes or
// attempt to redact arbitrary workload logs with these rules.
export const consoleSnapshotLimit = 20;
const fixtureMarkers = new Set([
  "RELAY_CONTRACT_READY",
  "RELAY_DIAGNOSTIC runtime=ready config=loaded",
]);
export function isConsoleMarker(value: unknown): value is string {
  return typeof value === "string" && fixtureMarkers.has(value);
}
