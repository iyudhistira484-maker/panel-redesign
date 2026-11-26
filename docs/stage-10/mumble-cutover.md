# Mumble staging cutover acceptance test

Do not use a production node. This rehearsal needs one disposable Wings host and two distinct clients on a private staging network. A single hosted runner checks loopback only and cannot certify this test. Use native Mumble clients; use test accounts, a synthetic audio source, and no production data.

## Preflight

1. Record Wings host and both client addresses, versions, the server UUID, container ID, start timestamp, and primary Mumble port. Confirm the clients are not on the Wings host. Restrict TCP and UDP ingress to the two client addresses on the staging network. Do not expose the Wings management port.
2. Start Mumble under Pterodactyl. Have both clients join the same channel. Verify both directions with a synthetic numbered tone sequence. Observe the clients' connection information and capture just the TCP/UDP packet metadata for the voice port. Confirm that disabling UDP for a short control window causes the clients to fall back to TCP or lose voice, and confirm that restoring UDP restores direct UDP voice. Status pings alone do not count.
3. Take a database and configuration backup using the staging backup procedure and verify recovery separately. Record the initial channel tree. Sync the clocks of the clients and host before collecting the baseline.

## Cutover and rollback

1. Follow the reversible control-plane switch in [pilot-runbook.md](pilot-runbook.md). Do not start a second Mumble process or restore an older SQLite database over the live one. Keep both clients connected and send the numbered tones throughout each switch.
2. With Relay authoritative, make a persistent test channel using an authorized test client. Have both clients join it and again verify bidirectional UDP voice. Record the channel name, creation time, and any gaps, reconnects or evidence of TCP fallback.
3. Restore Pterodactyl authority via the rollback procedure. Verify from both clients that the channel and audio still work. Reconnect one client and confirm the channel remains visible. Compare UUID, container ID and start timestamp with the baseline. After the continuous-session checks, perform one controlled stop/start on staging to confirm the channel was stored persistently.
4. Remove the temporary ingress rules and test accounts. Export only timestamps, connection states, observed gap lengths, and packet counts; do not retain audio or credentials.

## Evidence and pass criteria

Record baseline, cutover, Relay operation, rollback, and post-restart as separate phases. For each report TCP connections, UDP voice in both directions, missed numbered tones, reconnections, and any fallback. Fail if clients cannot reach the published port, if either client reconnects during a switch, if UDP voice falls back to TCP during a switch, or if the channel is lost. Report any observed audio gap even if the control-plane switch itself completed. Mark the rehearsal **not run** unless both independent clients and the actual staging cutover were exercised.
