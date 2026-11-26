# Draft upstream report: hash the full incoming archive part

**Base:** Pterodactyl Wings v1.13.5 (`3236480d078c09b823b8a8f21dab76c4029608a5`). Not submitted.

`postTransfer` hashes the incoming multipart archive through an `io.TeeReader`, but TAR extraction can stop before the archive part reaches EOF. `NextPart()` then advances over the remaining bytes without hashing them. A valid sender digest can therefore disagree with the receiver's partial digest. Drain the remainder through the same reader after successful extraction and before comparison; preserve error handling and checksum rejection.

- [Minimal patch](v1.13.5-transfer-checksum.patch)
- [Standalone Go reproduction](checksum_test.go): `go test ./patches/wings/checksum_test.go`
- [Disposable integration run](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45537149484): official sender, patched receiver; valid transfers succeed, and one changed gzip-header byte with unchanged checksum is rejected by the real receiver.

The report does not claim that every historical transfer error shares this cause. No production deployment or upstream submission has been made.

## SFTP revalidation (staging only)

`v1.13.5-sftp-lease.patch` applies to the same pinned Wings commit `3236480d078c09b823b8a8f21dab76c4029608a5`. The legacy-panel qualification job builds this patch; it does not replace user Wings installations. When a compatible panel returns an opaque `lease` at SFTP authentication, Wings asks `/api/remote/sftp/session` every two seconds, with a two-second request deadline, and closes the SSH transport on denial, mismatch, or callback failure. It does not retain the password or public key for revalidation. No lease means upstream behavior, to allow this binary to be tested against Pterodactyl unchanged; **stock Wings ignores leases and is not eligible for a Relay deployment that requires active SFTP revocation**. The patch does not cancel operations that already completed inside the revalidation window and is not a per-operation permission check. Relay issues leases only for the disposable SFTP harness, with a one-hour absolute lifetime.
