import { useEffect, useState } from "react";
import { Button } from "./ui";

type Item = { source: string; target: string };
type Result = Item & { status: string; error?: string };
type Batch = { batchId: string; halted: boolean; results: Result[] };
type Operation = "copy" | "move";

export function FileBatch({
  id,
  en,
  files,
  destinations,
  busy,
  onBusy,
  onComplete,
}: {
  id: string;
  en: boolean;
  files: string[];
  destinations: string[];
  busy: boolean;
  onBusy: (value: boolean) => void;
  onComplete: (operation: Operation, items: Result[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [operation, setOperation] = useState<Operation>("copy");
  const [destination, setDestination] = useState("");
  const [batch, setBatch] = useState<Batch | null>();
  const [error, setError] = useState(false);
  const base = `/api/v1/servers/${encodeURIComponent(id)}/files`;
  const statusUrl = `${base}/batch-status-fixture`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(statusUrl, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (!controller.signal.aborted) setBatch(body.batch);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [statusUrl]);
  const status = (value: string) =>
    en
      ? value.replaceAll("_", " ")
      : ({
          verified: "terverifikasi",
          rejected: "ditolak",
          unconfirmed: "belum terkonfirmasi",
          not_attempted: "belum dicoba",
        }[value] ?? value);
  async function send(check: boolean) {
    onBusy(true);
    setError(false);
    try {
      const response = await fetch(
        check ? statusUrl : `${base}/batch-fixture`,
        {
          method: "POST",
          headers: {
            "x-relay-request": "1",
            ...(check ? {} : { "content-type": "application/json" }),
          },
          ...(check
            ? {}
            : {
                body: JSON.stringify({
                  operation,
                  items: selected.map((source) => ({
                    source,
                    target: targets[source] ?? source,
                  })),
                  ...(operation === "move" ? { destination } : {}),
                }),
              }),
          signal: AbortSignal.timeout(90_000),
        },
      );
      if (!response.ok) throw new Error();
      const result = await response.json();
      setBatch(check ? result.batch : result);
      if (!check) {
        onComplete(operation, result.results);
        setSelected([]);
        setTargets({});
      }
    } catch {
      setBatch(undefined);
      setError(true);
    } finally {
      onBusy(false);
    }
  }
  return (
    <details>
      <summary>{en ? "File batch" : "Batch file"}</summary>
      <fieldset disabled={busy}>
        <legend>
          {en
            ? "Up to four files · 1 MiB each · offline only"
            : "Maksimal empat file · 1 MiB per file · khusus offline"}
        </legend>
        <label>
          {en ? "Batch operation" : "Operasi batch"}{" "}
          <select
            value={operation}
            onChange={(event) => {
              setOperation(
                event.currentTarget.value === "move" ? "move" : "copy",
              );
              setTargets({});
            }}
          >
            <option value="copy">{en ? "Copy" : "Salin"}</option>
            <option value="move">{en ? "Move" : "Pindah"}</option>
          </select>
        </label>{" "}
        {operation === "move" && (
          <label>
            {en ? "Batch destination" : "Tujuan batch"}{" "}
            <select
              value={destination}
              onChange={(event) => setDestination(event.currentTarget.value)}
            >
              <option value="">—</option>
              {destinations.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        )}{" "}
        <label>
          {en ? "Batch source files" : "Sumber batch"}{" "}
          <select
            multiple
            size={4}
            value={selected}
            onChange={(event) =>
              setSelected(
                Array.from(
                  event.currentTarget.selectedOptions,
                  (option) => option.value,
                ),
              )
            }
          >
            {files.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        {selected.length <= 4 &&
          selected.map((source) => (
            <label key={source} style={{ display: "block" }}>
              {source}{" "}
              <input
                aria-label={`${en ? "Target" : "Tujuan"} ${source}`}
                maxLength={80}
                value={targets[source] ?? (operation === "move" ? source : "")}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setTargets((current) => ({ ...current, [source]: value }));
                }}
              />
            </label>
          ))}
        <Button
          disabled={
            batch === undefined ||
            batch?.halted ||
            !selected.length ||
            selected.length > 4 ||
            (operation === "move"
              ? !destinations.includes(destination)
              : selected.some((name) => !targets[name]))
          }
          onClick={() => void send(false)}
        >
          {en ? "Run batch" : "Jalankan batch"}
        </Button>{" "}
        <Button onClick={() => void send(true)}>
          {en ? "Check batch result" : "Periksa hasil batch"}
        </Button>
      </fieldset>
      {error && (
        <output>
          {en
            ? "Result unavailable. Check before retrying."
            : "Hasil belum tersedia. Periksa sebelum mencoba lagi."}
        </output>
      )}
      {batch && (
        <div aria-live="polite">
          <p>
            Batch <code>{batch.batchId}</code>
          </p>
          {batch.halted && (
            <p>
              {en
                ? "Batch blocked. Check again after 60 seconds."
                : "Batch diblokir. Periksa lagi setelah 60 detik."}
            </p>
          )}
          <ul>
            {batch.results.map((item) => (
              <li key={item.source}>
                {item.source} → {item.target}: {status(item.status)}
                {item.error === "file_exists" &&
                  (en ? " (target exists)" : " (tujuan sudah ada)")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
