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
import type { FixtureBackupSignal } from "./remote";

const endpoint = "http://127.0.0.1:19300";
const bucket = "relay-disposable-backups";
const max = 4 * 1024 * 1024;
export async function s3Fixture(server: string, id: string) {
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
  let upload: string | undefined;
  let issued = false;
  let completed = false;
  let size = 0;
  await client.send(new CreateBucketCommand({ Bucket: bucket }), options());
  return {
    id,
    async urls(bytes: number) {
      if (issued || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > max)
        return null;
      issued = true;
      size = bytes;
      upload = (
        await client.send(
          new CreateMultipartUploadCommand({
            ...object,
            ContentType: "application/gzip",
          }),
          options(),
        )
      ).UploadId;
      if (!upload) throw new Error("Missing upload ID");
      return {
        part_size: 5 * 1024 * 1024,
        parts: [
          await getSignedUrl(
            client,
            new UploadPartCommand({
              ...object,
              UploadId: upload,
              PartNumber: 1,
            }),
            { expiresIn: 45 },
          ),
        ],
      };
    },
    async complete(event: FixtureBackupSignal) {
      const part = event.parts?.[0];
      if (
        !upload ||
        completed ||
        !event.successful ||
        event.size !== size ||
        event.checksum_type !== "sha1" ||
        !/^[a-f0-9]{40}$/.test(event.checksum ?? "") ||
        event.parts?.length !== 1 ||
        part?.part_number !== 1 ||
        !/^"?[a-f0-9]{32}"?$/.test(part.etag)
      )
        return false;
      await client.send(
        new CompleteMultipartUploadCommand({
          ...object,
          UploadId: upload,
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.etag }] },
        }),
        options(),
      );
      completed = true;
      return true;
    },
    async url() {
      if (!completed) throw new Error("S3 archive incomplete");
      return getSignedUrl(client, new GetObjectCommand(object), {
        expiresIn: 45,
      });
    },
    async verify(url: string, event: FixtureBackupSignal) {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(6000),
      });
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get("content-length")) !== size
      ) {
        await response.body?.cancel();
        throw new Error("Unexpected S3 object size");
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
    async close() {
      try {
        if (upload && !completed)
          await client.send(
            new AbortMultipartUploadCommand({ ...object, UploadId: upload }),
            options(),
          );
        await client.send(new DeleteObjectCommand(object), options());
      } finally {
        client.destroy();
      }
    },
  };
}
