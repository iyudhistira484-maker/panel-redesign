# Tahap 3 — Gerbang awal integrasi Wings

Bagian pertama hanya menguji **node kosong sekali pakai**, bukan adopsi. Jangan arahkan node yang sudah berisi server ke API ini: `/api/remote/servers` sengaja mengembalikan inventaris kosong dan `reset` tidak mengubah data. Fitur nonaktif secara default. Wings tidak diubah.

| Bagian | Berkas |
|---|---|
| Klien kesehatan `/api/system`, autentikasi bearer dan versi kandidat tepat 1.13.5, origin tetap, timeout/batas payload, penolakan redirect | `api/wings/client.ts`, `api/wings/health.ts` |
| Callback list dan reset untuk bootstrap kosong dengan token khusus node, terpisah dari sesi browser | `api/wings/remote.ts`, `api/app.ts`, `api/server.ts`, `.env.staging.example` |
| Tes in-process dan harness Wings asli dalam Docker pada runner GitHub sekali pakai | `api/wings/bootstrap.test.ts`, `api/wings/live-contract.ts`, `scripts/wings-contract.sh`, `.github/workflows/foundation.yml` |

`npm ci && npm run test:wings` menjalankan tes lokal tanpa daemon. Job `wings-bootstrap` menjalankan binary rilis upstream Linux amd64, dipatok SHA-256, pada runner resmi sekali pakai. Docker socket hanya diberikan ke Wings upstream dalam job push ini; jangan jalankan skrip di host bersama atau produksi. HTTP hanya digunakan pada loopback lingkungan kualifikasi, bukan rancangan transport deployment. Jika memakai server kosong staging secara terpisah, aktifkan pengaturan `RELAY_ENABLE_EMPTY_WINGS_TEST_NODE=1` dan isi pasangan token uji di env lokal; gunakan `npm run wings:health`. Jangan menjalankan skrip CI di mesin itu.

**Belum selesai:** penyimpanan banyak node, pembuatan konfigurasi dan adopsi node, alokasi, PTDL v1/v2, JWT dan websocket, operasi server (buat/install/reinstall/power/hapus/transfer), serta callback install, SFTP, backup dan activity. Tidak ada klaim kompatibilitas adopsi atau paritas dari tes bootstrap.
