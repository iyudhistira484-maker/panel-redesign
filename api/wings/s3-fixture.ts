import { createHash } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Pool, ResultSetHeader } from "mysql2/promise";
import { rows } from "../db";
import type { FixtureBackupSignal } from "./remote";

const endpoint = "http://127.0.0.1:19300";
const bucket = "relay-disposable-backups";
const max = 4 * 1024 * 1024;
export function s3Fixture(
  pool: Pool,
  server: string,
  node: string,
  id: string,
) {
  const accessKeyId = process.env.RELAY_S3_FIXTURE_USER;
  const secretAccessKey = process.env.RELAY_S3_FIXTURE_PASSWORD;
  if (
    process.env.RELAY_DISPOSABLE_WINGS_CI !== "1" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.RELAY_BOOTSTRAP_SCENARIO !== "legacy-panel" ||
    !accessKeyId ||
    !secretAccessKey
  )
    throw new Error("Disposable S3 fixture required");
  const client = new S3Client({
    endpoint,
    forcePathStyle: true,
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const object = { Bucket: bucket, Key: `${server}/${id}.tar.gz` };
  const options = () => ({ abortSignal: AbortSignal.timeout(6000) });
  type Receipt = {
    state: string;
    upload_id: string | null;
    size_bytes: number | null;
    checksum: string | null;
  };
  const binding = [id, server, node];
  const receipt = async () =>
    (
      await rows<Receipt>(
        pool,
        `SELECT r.state,r.upload_id,r.size_bytes,r.checksum FROM s3_fixture_receipts r JOIN servers s ON s.id=r.server_id AND s.node_id=r.node_id WHERE r.id=? AND r.server_id=? AND r.node_id=?`,
        binding,
      )
    )[0];
  const advance = async (from: string, to: string) => {
    const [changed] = await pool.execute<ResultSetHeader>(
      "UPDATE s3_fixture_receipts SET state=? WHERE id=? AND server_id=? AND node_id=? AND state=?",
      [to, ...binding, from],
    );
    return changed.affectedRows === 1;
  };
  const signedGet = () =>
    getSignedUrl(
      client,
      new GetObjectCommand({
        ...object,
        ResponseContentType: "application/gzip",
      }),
      { expiresIn: 45 },
    );
  const store = {
    id,
    async initialize() {
      await client.send(new CreateBucketCommand({ Bucket: bucket }), options());
    },
    async reserve() {
      const [result] = await pool.execute<ResultSetHeader>(
        "INSERT INTO s3_fixture_receipts (id,server_id,node_id) SELECT ?,id,node_id FROM servers WHERE id=? AND node_id=?",
        binding,
      );
      if (result.affectedRows !== 1)
        throw new Error("S3 receipt binding missing");
    },
    async urls(bytes: number) {
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > max ||
        !(await receipt()) ||
        !(await advance("reserved", "allocating"))
      )
        return null;
      const upload = (
        await client.send(
          new CreateMultipartUploadCommand({
            ...object,
            ContentType: "application/gzip",
          }),
          options(),
        )
      ).UploadId;
      if (!upload || upload.length > 1024)
        throw new Error("Invalid S3 upload identifier");
      const [saved] = await pool.execute<ResultSetHeader>(
        "UPDATE s3_fixture_receipts SET state='uploading',upload_id=?,size_bytes=? WHERE id=? AND server_id=? AND node_id=? AND state='allocating'",
        [upload, bytes, ...binding],
      );
      if (saved.affectedRows !== 1)
        throw new Error("S3 receipt changed during allocation");
      return {
        part_size: 5 * 1024 * 1024,
        parts: [
          await getSignedUrl(
            client,
            new UploadPartCommand({
              ...object,
              UploadId: upload,
              PartNumber: 1,
              ContentLength: bytes,
            }),
            { expiresIn: 45, signableHeaders: new Set(["content-length"]) },
          ),
        ],
      };
    },
    async complete(event: FixtureBackupSignal) {
      const row = await receipt();
      const part = event.parts?.[0];
      if (
        !row?.upload_id ||
        row.state !== "uploading" ||
        !event.successful ||
        event.size !== row.size_bytes ||
        event.checksum_type !== "sha1" ||
        !/^[a-f0-9]{40}$/.test(event.checksum ?? "") ||
        event.parts?.length !== 1 ||
        part?.part_number !== 1 ||
        !/^"?[a-f0-9]{32}"?$/.test(part.etag) ||
        !(await advance("uploading", "completing"))
      )
        return false;
      await client.send(
        new CompleteMultipartUploadCommand({
          ...object,
          UploadId: row.upload_id,
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.etag }] },
        }),
        options(),
      );
      await store.verify(await signedGet(), event);
      const [saved] = await pool.execute<ResultSetHeader>(
        "UPDATE s3_fixture_receipts SET state='ready',checksum=?,upload_id=NULL WHERE id=? AND server_id=? AND node_id=? AND state='completing'",
        [event.checksum ?? null, ...binding],
      );
      return saved.affectedRows === 1;
    },
    async url() {
      if ((await receipt())?.state !== "ready")
        throw new Error("S3 archive incomplete");
      return signedGet();
    },
    async status() {
      const row = await receipt();
      return row
        ? { state: row.state, size: row.size_bytes, checksum: row.checksum }
        : null;
    },
    async verify(url: string, event: FixtureBackupSignal) {
      const size = event.size ?? 0;
      if (size < 1 || size > max) throw new Error("Invalid S3 archive size");
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(6000),
      });
      if (
        !response.ok ||
        !response.body ||
        response.headers.get("content-type")?.split(";")[0] !==
          "application/gzip" ||
        Number(response.headers.get("content-length")) !== size
      ) {
        await response.body?.cancel();
        throw new Error("Unexpected S3 object response");
      }
      const reader = response.body.getReader();
      let received = 0;
      const hash = createHash("sha1");
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > size) throw new Error("Oversized S3 object");
          hash.update(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (received !== size || hash.digest("hex") !== event.checksum)
        throw new Error("S3 object integrity mismatch");
    },
    async remove() {
      const row = await receipt();
      if (!row) return;
      if (!["reserved", "uploading", "ready", "deleting"].includes(row.state))
        throw new Error("S3 operation requires inspection");
      if (row.state !== "deleting" && !(await advance(row.state, "deleting")))
        throw new Error("S3 receipt changed during deletion");
      if (row.upload_id) {
        try {
          await client.send(
            new AbortMultipartUploadCommand({
              ...object,
              UploadId: row.upload_id,
            }),
            options(),
          );
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "NoSuchUpload")
            throw error;
        }
      }
      await client.send(new DeleteObjectCommand(object), options());
      await pool.execute(
        "DELETE FROM s3_fixture_receipts WHERE id=? AND server_id=? AND node_id=? AND state='deleting'",
        binding,
      );
    },
    dispose() {
      client.destroy();
    },
  };
  return store;
}
