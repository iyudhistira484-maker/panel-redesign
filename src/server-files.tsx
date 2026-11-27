import { useEffect, useRef, useState } from "react";
import type { Locale } from "./i18n";
import { Button } from "./ui";

type Entry = {
  name: string;
  directory: boolean;
  size: number;
  movable?: boolean;
  children?: string[];
};
export function ServerFiles({ id, locale }: { id: string; locale: Locale }) {
  const en = locale === "en";
  const [path, setPath] = useState<string[]>([]);
  const [items, setItems] = useState<Entry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState<{
    name: string;
    text: string;
    version: string;
  } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    "saved" | "conflict" | "error" | null
  >(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<
    "uploaded" | "conflict" | "invalid" | "unknown" | null
  >(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [copySource, setCopySource] = useState("");
  const destinations =
    items?.flatMap((item) =>
      item.movable ? [item.name, ...(item.children ?? [])] : [],
    ) ?? [];
  const [moveFolder, setMoveFolder] = useState("moved");
  const [inMoveFolder, setInMoveFolder] = useState(false);
  const [copyTarget, setCopyTarget] = useState("");
  const [copyStatus, setCopyStatus] = useState<"verified" | "unknown" | null>(
    null,
  );
  const [archive, setArchive] = useState<File | null>(null);
  const [archiveStatus, setArchiveStatus] = useState<
    | {
        kind:
          | "invalid"
          | "unknown"
          | "rejected"
          | "retryable"
          | "pending"
          | "none";
      }
    | { kind: "done"; directory: string }
    | null
  >(null);
  const [zipNames, setZipNames] = useState<string[]>([]);
  const archiveInput = useRef<HTMLInputElement>(null);
  async function checkArchive() {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/files/reconcile-zip-fixture`,
        {
          method: "POST",
          headers: { "x-relay-request": "1" },
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw new Error();
      const result = await response.json();
      setArchiveStatus(
        result.status === "succeeded"
          ? { kind: "done", directory: result.directory }
          : {
              kind:
                result.status === "retryable"
                  ? "retryable"
                  : result.status === "pending"
                    ? "pending"
                    : result.status === "none"
                      ? "none"
                      : "unknown",
            },
      );
    } catch {
      setArchiveStatus({ kind: "unknown" });
    } finally {
      setBusy(false);
    }
  }
  async function extractArchive() {
    if (!archive || busy) return;
    setArchiveStatus(null);
    const zip = archive.name.endsWith(".zip");
    if (
      (!zip && !archive.name.endsWith(".gz")) ||
      archive.size > (zip ? 70000 : 16512) ||
      archive.size === 0
    ) {
      setArchiveStatus({ kind: "invalid" });
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await archive.arrayBuffer());
      const reply = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/files/${zip ? "unzip" : "gunzip"}-fixture`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-relay-request": "1",
          },
          body: JSON.stringify({
            content: btoa(String.fromCharCode(...bytes)),
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (reply.status === 400) {
        setArchiveStatus({ kind: "invalid" });
        return;
      }
      if (
        reply.status === 409 &&
        (await reply.json()).error === "server_not_offline"
      ) {
        setArchiveStatus({ kind: "rejected" });
        return;
      }
      if (reply.status !== 201) throw new Error("Extraction unverified");
      const result = (await reply.json()) as {
        directory: string;
        name: string;
        size: number;
        count: number;
      };
      if (
        !/^\/fixture-docs\/extract-[0-9a-f]{32}$/.test(result.directory) ||
        (zip
          ? !Number.isInteger(result.count) ||
            result.count < 1 ||
            result.count > 4
          : result.name !== "extracted.txt" ||
            !Number.isSafeInteger(result.size) ||
            result.size < 0 ||
            result.size > 16384)
      )
        throw new Error("Extraction unverified");
      const name = result.directory.slice("/fixture-docs/".length);
      setItems(
        (current) =>
          current &&
          [...current, { name, directory: true, size: 0 }].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
      );
      setArchiveStatus({ kind: "done", directory: result.directory });
      setArchive(null);
      if (archiveInput.current) archiveInput.current.value = "";
    } catch {
      setArchiveStatus({ kind: "unknown" });
    } finally {
      setBusy(false);
    }
  }
  async function copyFile(rename = false, moved = false, back = "", mode = "") {
    const folder = mode === "folder";
    const source = back || copySource,
      target = mode && !folder ? source : back || copyTarget;
    if (
      busy ||
      (folder
        ? !/^[a-z][a-z0-9_/-]{0,96}$/.test(target)
        : !source ||
          !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,79}$/.test(target) ||
          !target.endsWith(".txt"))
    )
      return;
    setBusy(true);
    setCopyStatus(null);
    try {
      const reply = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/files/${folder ? "create-folder" : mode ? "chmod" : rename ? "rename" : "copy"}-fixture`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-relay-request": "1",
          },
          body: JSON.stringify(
            folder
              ? { name: target }
              : mode
                ? { name: source, mode }
                : {
                    source,
                    target,
                    ...(moved || back
                      ? {
                          destination: moved ? moveFolder : "parent",
                          ...(back
                            ? { sourceFolder: path.slice(1).join("/") }
                            : {}),
                        }
                      : {}),
                  },
          ),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (reply.status !== (!folder && (mode || rename) ? 200 : 201))
        throw new Error();
      const data = (await reply.json()) as {
        name?: string;
        size: number;
        mode?: string;
        movable?: boolean;
      };
      if (folder) {
        if (data.name !== target || !data.movable) throw new Error();
        const [parent, child] = target.split("/");
        setItems(
          (current) =>
            current &&
            (child
              ? current.map((item) =>
                  item.name === parent
                    ? { ...item, children: [...(item.children ?? []), target] }
                    : item,
                )
              : [
                  ...current,
                  { name: target, size: 0, directory: true, movable: true },
                ]),
        );
        setMoveFolder(target);
        setCopyTarget("");
        setCopyStatus("verified");
        return;
      }
      if (mode) {
        if (data.name !== source || data.mode !== mode) throw new Error();
        setCopyStatus("verified");
        return;
      }
      if (
        data.name !== target ||
        !Number.isSafeInteger(data.size) ||
        data.size < 0 ||
        data.size > 16384
      )
        throw new Error();
      setItems(
        (current) =>
          current &&
          [
            ...current.filter((item) => !rename || item.name !== source),
            ...(!moved && !back
              ? [{ name: target, size: data.size, directory: false }]
              : []),
          ].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setCopyTarget("");
      if (rename) {
        setCopySource("");
        setPreview(null);
        setDraft(null);
      }
      setCopyStatus("verified");
    } catch {
      setCopyStatus("unknown");
    } finally {
      setBusy(false);
    }
  }
  async function upload() {
    if (!uploadFile || busy) return;
    setUploadStatus(null);
    if (
      !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,79}$/.test(uploadFile.name) ||
      !uploadFile.name.endsWith(".txt") ||
      uploadFile.size > 16384
    ) {
      setUploadStatus("invalid");
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await uploadFile.arrayBuffer());
      const response = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/files/upload-fixture`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-relay-request": "1",
          },
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify({
            name: uploadFile.name,
            content: btoa(String.fromCharCode(...bytes)),
          }),
        },
      );
      if (response.status === 409) {
        setUploadStatus("conflict");
        return;
      }
      if (response.status === 400) {
        setUploadStatus("invalid");
        return;
      }
      if (response.status !== 201) throw new Error("Upload unverified");
      const created = (await response.json()) as { name?: string };
      if (created.name !== uploadFile.name)
        throw new Error("Upload unverified");
      setItems(
        (current) =>
          current &&
          [
            ...current,
            { name: uploadFile.name, directory: false, size: bytes.length },
          ].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setUploadFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setUploadStatus("uploaded");
    } catch {
      setUploadStatus("unknown");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (
      !preview ||
      draft === null ||
      busy ||
      new TextEncoder().encode(draft).length > 16384
    )
      return;
    setBusy(true);
    setSaveStatus(null);
    try {
      const response = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/files/edit-fixture`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-relay-request": "1",
          },
          body: JSON.stringify({ version: preview.version, text: draft }),
          signal: AbortSignal.timeout(30000),
        },
      );
      const data = await response.json();
      if (response.status === 409 && data?.error === "file_version_conflict") {
        setSaveStatus("conflict");
        return;
      }
      if (
        !response.ok ||
        data?.name !== preview.name ||
        typeof data.text !== "string" ||
        typeof data.version !== "string"
      )
        throw new Error("Save unverified");
      setPreview(data);
      setDraft(null);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    } finally {
      setBusy(false);
    }
  }
  async function openText(name: string) {
    setDraft(null);
    setSaveStatus(null);
    setDownloadError(false);
    setPreview(null);
    setPreviewError(false);
    setBusy(true);
    try {
      const query = new URLSearchParams({
        directory: `/${path.join("/")}`,
        preview: name,
      });
      const response = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/files?${query}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw new Error("Preview unavailable");
      const data = await response.json();
      if (
        data?.name !== name ||
        typeof data.text !== "string" ||
        data.text.length > 16384 ||
        typeof data.version !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.version)
      )
        throw new Error("Invalid preview");
      setPreview(data);
    } catch {
      setPreviewError(true);
    } finally {
      setBusy(false);
    }
  }
  const [downloadError, setDownloadError] = useState(false);
  const pendingDownload = useRef<AbortController | null>(null);
  useEffect(() => () => pendingDownload.current?.abort(), []);
  async function downloadFile(name: string, gzip = false) {
    const controller = new AbortController();
    pendingDownload.current = controller;
    setBusy(true);
    setDownloadError(false);
    try {
      const query = new URLSearchParams({
        directory: `/${path.join("/")}`,
        preview: name,
        download: "1",
      });
      const response = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/files${gzip ? `/gzip-fixture?${new URLSearchParams({ name })}` : `?${query}`}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30000),
          ]),
        },
      );
      if (
        !response.ok ||
        !response.headers.get("content-disposition")?.startsWith("attachment;")
      )
        throw new Error("Download unavailable");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (blob.size > (gzip ? 16512 : 16384))
        throw new Error("Invalid attachment");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = gzip ? `${name}.gz` : name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (!controller.signal.aborted) setDownloadError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (pendingDownload.current === controller)
        pendingDownload.current = null;
    }
  }
  async function load(parts: string[]) {
    setDraft(null);
    setSaveStatus(null);
    setDownloadError(false);
    setPreview(null);
    setPreviewError(false);
    setBusy(true);
    setItems(null);
    setError(false);
    setPath(parts);
    setCopyStatus(null);
    try {
      const query = new URLSearchParams({ directory: `/${parts.join("/")}` });
      const response = await fetch(
        `/api/v1/servers/${encodeURIComponent(id)}/files?${query}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw new Error("Invalid directory");
      const data = (await response.json()) as Entry[];
      if (
        !Array.isArray(data) ||
        data.length > 100 ||
        !data.every(
          (row) =>
            typeof row?.name === "string" &&
            typeof row.directory === "boolean" &&
            Number.isSafeInteger(row.size),
        )
      )
        throw new Error("Invalid directory");
      setItems(data);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-busy={busy}>
      <h3>{en ? "Staging server files" : "File server staging"}</h3>
      {path.length === 1 && path[0] === "fixture-docs" && (
        <div>
          <label>
            {en ? "Text file to upload" : "File teks untuk diunggah"}{" "}
            <input
              ref={fileInput}
              type="file"
              accept=".txt"
              disabled={busy}
              onChange={(event) => {
                setUploadFile(event.currentTarget.files?.[0] ?? null);
                setUploadStatus(null);
              }}
            />
          </label>
          <p>
            {en
              ? "Offline server only. New UTF-8 .txt files up to 16 KiB; no overwrite."
              : "Server harus offline. File .txt UTF-8 baru hingga 16 KiB; tidak menimpa file lama."}
          </p>
          <Button disabled={!uploadFile || busy} onClick={() => void upload()}>
            {en ? "Upload new file" : "Unggah file baru"}
          </Button>
          {uploadStatus && (
            <output>
              {
                {
                  uploaded: en ? "Upload verified." : "Unggahan terverifikasi.",
                  conflict: en
                    ? "File already exists or server is not offline."
                    : "File sudah ada atau server tidak offline.",
                  invalid: en ? "Invalid text file." : "File teks tidak valid.",
                  unknown: en
                    ? "Check before retrying."
                    : "Periksa sebelum mencoba lagi.",
                }[uploadStatus]
              }
            </output>
          )}
        </div>
      )}
      {path.join("/") === "fixture-docs" && items && (
        <div>
          <label>
            {en ? "Source text file" : "File teks sumber"}{" "}
            <select
              value={copySource}
              disabled={busy}
              onChange={(e) => {
                setCopySource(e.currentTarget.value);
                setCopyStatus(null);
              }}
            >
              <option value="">
                {en ? "Choose a text file" : "Pilih file teks"}
              </option>
              {items
                .filter(
                  (item) =>
                    !item.directory &&
                    item.name.endsWith(".txt") &&
                    item.size <= 16384,
                )
                .map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>{" "}
          <label>
            {en ? "Name / path" : "Nama / jalur"}{" "}
            <input
              value={copyTarget}
              maxLength={80}
              disabled={busy}
              onChange={(e) => {
                setCopyTarget(e.currentTarget.value);
                setCopyStatus(null);
              }}
            />
          </label>{" "}
          <Button
            disabled={
              busy ||
              !copySource ||
              copySource === copyTarget ||
              !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,79}$/.test(copyTarget) ||
              !copyTarget.endsWith(".txt")
            }
            onClick={() => void copyFile()}
          >
            {en ? "Copy text file" : "Salin file teks"}
          </Button>
          <Button
            disabled={
              busy ||
              !copySource ||
              copySource === copyTarget ||
              !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,79}$/.test(copyTarget) ||
              !copyTarget.endsWith(".txt")
            }
            onClick={() => void copyFile(true)}
          >
            {en ? "Rename uploaded file" : "Ubah nama file unggahan"}
          </Button>
          <label>
            {en ? "Destination folder" : "Folder tujuan"}{" "}
            <select
              value={moveFolder}
              onChange={(event) => setMoveFolder(event.currentTarget.value)}
              disabled={busy}
            >
              {destinations.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>{" "}
          <Button
            disabled={
              busy ||
              !copySource ||
              !copyTarget ||
              !destinations.includes(moveFolder)
            }
            onClick={() => void copyFile(true, true)}
          >
            {en ? "Move file" : "Pindahkan file"}
          </Button>
          <Button
            disabled={busy || !copyTarget}
            onClick={() => void copyFile(false, false, "", "folder")}
          >
            {en ? "Create folder" : "Buat folder"}
          </Button>
          <span>
            chmod{" "}
            {["600", "644"].map((mode) => (
              <Button
                key={mode}
                disabled={busy || !copySource}
                onClick={() => void copyFile(false, false, "", mode)}
              >
                {mode}
              </Button>
            ))}
          </span>
        </div>
      )}
      {path.join("/") === "fixture-docs" && items && (
        <div>
          <p>
            {en
              ? "Gzip (1), ZIP (4), 16 KiB each."
              : "Gzip (1), ZIP (4), 16 KiB per file."}
          </p>
          <Button
            disabled={busy || !copySource}
            onClick={() => void downloadFile(copySource, true)}
          >
            {en ? "Download as gzip" : "Unduh sebagai gzip"}
          </Button>{" "}
          <label>
            {en ? "ZIP source files" : "File sumber ZIP"}{" "}
            <select
              multiple
              size={3}
              value={zipNames}
              disabled={busy}
              onChange={(event) =>
                setZipNames(
                  Array.from(
                    event.currentTarget.selectedOptions,
                    (option) => option.value,
                  ),
                )
              }
            >
              {items
                .filter(
                  (item) =>
                    !item.directory &&
                    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}\.txt$/.test(item.name),
                )
                .map((item) => (
                  <option key={item.name}>{item.name}</option>
                ))}
            </select>
          </label>{" "}
          {zipNames.length > 0 && zipNames.length <= 4 && (
            <a
              href={`/api/v1/servers/${encodeURIComponent(id)}/files/zip-fixture?${new URLSearchParams({ names: zipNames.join(",") })}`}
              download
            >
              {en ? "Download ZIP" : "Unduh ZIP"}
            </a>
          )}{" "}
          <label>
            {en ? "Archive to extract" : "Arsip untuk diekstrak"}{" "}
            <input
              ref={archiveInput}
              type="file"
              accept=".gz,.zip,application/gzip,application/zip"
              disabled={busy}
              onChange={(event) => {
                setArchive(event.currentTarget.files?.[0] ?? null);
                setArchiveStatus(null);
              }}
            />
          </label>{" "}
          <Button
            disabled={busy || !archive}
            onClick={() => void extractArchive()}
          >
            {en ? "Extract to new folder" : "Ekstrak ke folder baru"}
          </Button>
          <Button disabled={busy} onClick={() => void checkArchive()}>
            {en ? "Check ZIP extraction" : "Periksa hasil ekstraksi ZIP"}
          </Button>
          {archiveStatus && (
            <output>
              {archiveStatus.kind === "done"
                ? en
                  ? `Extracted and verified: ${archiveStatus.directory}`
                  : `Ekstraksi terverifikasi: ${archiveStatus.directory}`
                : archiveStatus.kind === "retryable"
                  ? en
                    ? "Safe to retry."
                    : "Aman dicoba ulang."
                  : archiveStatus.kind === "pending"
                    ? en
                      ? "Check again later."
                      : "Periksa lagi nanti."
                    : archiveStatus.kind === "none"
                      ? en
                        ? "No ZIP operation."
                        : "Belum ada operasi ZIP."
                      : archiveStatus.kind === "invalid"
                        ? en
                          ? "Invalid text archive."
                          : "Arsip teks tidak valid."
                        : archiveStatus.kind === "rejected"
                          ? en
                            ? "Extraction requires an offline server."
                            : "Ekstraksi membutuhkan server offline."
                          : en
                            ? "Check before retrying."
                            : "Periksa sebelum mencoba lagi."}
            </output>
          )}
        </div>
      )}
      <Button onClick={() => void load([])} disabled={busy}>
        {en ? "Open file list" : "Buka daftar file"}
      </Button>
      {!!path.length && (
        <Button onClick={() => void load(path.slice(0, -1))} disabled={busy}>
          {en ? "Parent folder" : "Folder induk"}
        </Button>
      )}
      {(items || error || busy) && (
        <p>
          <code>/{path.join("/")}</code>
        </p>
      )}
      {error && (
        <p role="alert">
          {en
            ? "The folder could not be listed."
            : "Daftar folder tidak dapat dimuat."}
        </p>
      )}
      {items?.length === 0 && (
        <output>{en ? "Empty folder." : "Folder kosong."}</output>
      )}
      {!!items?.length && (
        <ul aria-label={en ? "Folder entries" : "Isi folder"}>
          {items.map((item) => (
            <li key={item.name}>
              {item.directory && path.length < 4 ? (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setInMoveFolder(!!item.movable);
                    void load([...path, item.name]);
                  }}
                >
                  {item.name}
                </Button>
              ) : !item.directory &&
                item.name.endsWith(".txt") &&
                item.size <= 16384 ? (
                <Button
                  disabled={busy}
                  onClick={() => void openText(item.name)}
                >
                  {item.name}
                </Button>
              ) : (
                <span>
                  {item.name}
                  {item.directory ? "/" : ` · ${item.size} B`}
                </span>
              )}
              {!item.directory &&
                item.name.endsWith(".txt") &&
                item.size <= 16384 && (
                  <Button
                    disabled={busy}
                    aria-label={`${en ? "Download" : "Unduh"} ${item.name}`}
                    onClick={() => void downloadFile(item.name)}
                  >
                    {en ? "Download" : "Unduh"}
                  </Button>
                )}
            </li>
          ))}
        </ul>
      )}
      {copyStatus && (
        <output>
          {copyStatus === "verified"
            ? en
              ? "Operation verified."
              : "Operasi terverifikasi."
            : en
              ? "Operation not confirmed."
              : "Operasi belum terkonfirmasi."}
        </output>
      )}
      {downloadError && (
        <p role="alert">
          {en ? "Download unavailable." : "Unduhan tidak tersedia."}
        </p>
      )}
      {previewError && (
        <p role="alert">
          {en ? "Preview unavailable." : "Pratinjau tidak tersedia."}
        </p>
      )}
      {preview && (
        <section aria-label={en ? "Text preview" : "Pratinjau teks"}>
          <h4>{preview.name}</h4>
          <Button
            disabled={busy}
            onClick={() => void downloadFile(preview.name)}
          >
            {en ? "Download text file" : "Unduh file teks"}
          </Button>
          {path.length > 1 && inMoveFolder && (
            <Button
              disabled={busy}
              onClick={() => void copyFile(true, false, preview.name)}
            >
              {en
                ? "Move back to fixture-docs"
                : "Pindahkan kembali ke fixture-docs"}
            </Button>
          )}
          {path.join("/") === "fixture-docs" &&
            preview.name === "example.txt" &&
            (draft === null ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setSaveStatus(null);
                  setDraft(preview.text);
                }}
              >
                {en ? "Edit staging text" : "Edit teks staging"}
              </Button>
            ) : (
              <>
                <p>
                  {en ? "The server must be offline." : "Server harus offline."}
                </p>
                <textarea
                  aria-label={en ? "Text editor" : "Editor teks"}
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  maxLength={16384}
                  rows={6}
                  disabled={busy}
                />
                <Button
                  disabled={
                    busy ||
                    saveStatus !== null ||
                    new TextEncoder().encode(draft).length > 16384
                  }
                  onClick={() => void save()}
                >
                  {en ? "Save text" : "Simpan teks"}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void openText(preview.name)}
                >
                  {en ? "Reload file" : "Muat ulang file"}
                </Button>
              </>
            ))}
          {saveStatus === "saved" && (
            <output>
              {en ? "Saved and verified." : "Tersimpan dan terverifikasi."}
            </output>
          )}
          {saveStatus === "conflict" && (
            <p role="alert">
              {en
                ? "File changed. Reload before saving."
                : "File sudah berubah. Muat ulang sebelum menyimpan."}
            </p>
          )}
          {saveStatus === "error" && (
            <p role="alert">
              {en
                ? "Save not verified. Check the server and reload the file."
                : "Penyimpanan belum terverifikasi. Periksa server dan muat ulang file."}
            </p>
          )}
          <pre>{preview.text}</pre>
        </section>
      )}
    </section>
  );
}
