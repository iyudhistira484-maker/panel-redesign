import { useEffect, useRef, useState } from "react";
import type { Locale } from "./i18n";
import { Button } from "./ui";

type Entry = { name: string; directory: boolean; size: number };
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
      setUploadFile(null);
      if (fileInput.current) fileInput.current.value = "";
      await load(["fixture-docs"]);
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
  async function downloadFile(name: string) {
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
        `/api/v1/servers/${encodeURIComponent(id)}/files?${query}`,
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
      if (blob.size > 16384) throw new Error("Invalid attachment");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
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
      if (!response.ok) throw new Error("Directory unavailable");
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
        throw new Error("Invalid listing");
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
                    ? "Upload not confirmed. Check the file list before retrying."
                    : "Unggahan belum terkonfirmasi. Periksa daftar file sebelum mencoba lagi.",
                }[uploadStatus]
              }
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
        <output>
          {en
            ? "No visible entries."
            : "Tidak ada entri yang dapat ditampilkan."}
        </output>
      )}
      {!!items?.length && (
        <ul aria-label={en ? "Folder entries" : "Isi folder"}>
          {items.map((item) => (
            <li key={item.name}>
              {item.directory && path.length < 4 ? (
                <Button
                  disabled={busy}
                  onClick={() => void load([...path, item.name])}
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
            </li>
          ))}
        </ul>
      )}
      {downloadError && (
        <p role="alert">
          {en ? "Download unavailable." : "Unduhan tidak tersedia."}
        </p>
      )}
      {previewError && (
        <p role="alert">
          {en ? "Text preview unavailable." : "Pratinjau teks tidak tersedia."}
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
