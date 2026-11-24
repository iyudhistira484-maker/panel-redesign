# Tahap 3 — Gerbang awal integrasi Wings

Bagian pertama hanya menguji **node kosong sekali pakai**, bukan adopsi. Jangan arahkan node yang sudah berisi server ke API ini: `/api/remote/servers` sengaja mengembalikan inventaris kosong dan `reset` tidak mengubah data. Fitur nonaktif secara default. Wings tidak diubah.

| Bagian | Berkas |
|---|---|
| Klien kesehatan `/api/system`, autentikasi bearer dan versi kandidat tepat 1.13.5, origin tetap, timeout/batas payload, penolakan redirect | `api/wings/client.ts`, `api/wings/health.ts` |
| Callback list dan reset untuk bootstrap kosong dengan token khusus node, terpisah dari sesi browser | `api/wings/remote.ts`, `api/app.ts`, `api/server.ts`, `.env.staging.example` |
| Tes in-process dan harness Wings asli dalam Docker pada runner GitHub sekali pakai | `api/wings/bootstrap.test.ts`, `api/wings/live-contract.ts`, `scripts/wings-contract.sh`, `.github/workflows/foundation.yml` |

`npm ci && npm run test:wings` menjalankan tes lokal tanpa daemon. Job `wings-bootstrap` menjalankan binary rilis upstream Linux amd64, dipatok SHA-256, pada runner resmi sekali pakai. Docker socket hanya diberikan ke Wings upstream dalam job push ini; jangan jalankan skrip di host bersama atau produksi. HTTP hanya digunakan pada loopback lingkungan kualifikasi, bukan rancangan transport deployment. Jika memakai server kosong staging secara terpisah, aktifkan pengaturan `RELAY_ENABLE_EMPTY_WINGS_TEST_NODE=1` dan isi pasangan token uji di env lokal; gunakan `npm run wings:health`. Jangan menjalankan skrip CI di mesin itu.

**Belum selesai:** penyimpanan banyak node, pembuatan konfigurasi dan adopsi node, alokasi, PTDL v1/v2, JWT dan websocket, operasi server (buat/install/reinstall/power/hapus/transfer), serta callback install, SFTP, backup dan activity. Tidak ada klaim kompatibilitas adopsi atau paritas dari tes bootstrap.

Uji daemon pertama menangkap perbedaan pagination: Wings mengirim `page=0` saat bootstrap. Relay sekarang menerima nilai itu sebagai alias halaman pertama dan mengembalikan `current_page: 1`; nilai negatif tetap ditolak. Lihat `remote/servers.go` pada sumber Wings yang dipatok.

**Hasil kualifikasi awal:** [GitHub Actions 45350328028](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45350328028) lulus untuk `wings-bootstrap`, `identity`, dan `verify`. Harness daemon membuktikan health terautentikasi (permintaan tanpa token ditolak) dan callback list/reset ketika node kosong. Ini belum mencakup operasi workload.

## Potongan berikutnya — lifecycle dan dokumen egg

- `api/wings/client.ts` kini mempunyai pengiriman create, start, stop, baca status, dan delete untuk UUID v4 pada node loopback. `api/wings/remote.ts` dan `api/wings/lifecycle-fixture.ts` memberi daemon CI konfigurasi dan skrip instalasi **hanya untuk satu fixture**. `api/wings/live-contract.ts` membedakan penerimaan HTTP 202 dari callback instalasi dan status proses yang nyata. Tidak ada endpoint admin/pengguna baru atau penyimpanan workload permanen.
- `scripts/wings-contract.sh` membuat image workload lokal dari Alpine dan memasang direktori data, instalasi, serta `machine_id` dengan jalur identik di host Docker dan container Wings. Uji pertama menemukan bahwa `/run/wings/machine-id` yang hanya ada di container Wings tidak bisa dipasang oleh Docker host. Konfigurasi fixture diperbaiki; source Wings tetap utuh.
- `api/eggs/codec.ts` mengenali PTDL_v1/v2, mempertahankan dokumen asli pada ekspor versi yang sama, serta menolak konversi ke v1 jika label image akan hilang. `api/eggs/codec.test.ts`, `package.json` dan workflow menambahkan tes codec. Uji lokal tambahan mengekspor ulang 14 egg bawaan Panel dari checkout upstream tanpa perubahan byte. Ini **belum** menguji instalasi egg bawaan, evaluator aturan variabel, penyimpanan egg/nest, atau kompatibilitas seluruh egg kustom. Tidak ada egg upstream yang disalin ke repositori ini.

Jalankan `npm run test:wings` dan `npm run test:eggs` untuk uji lokal. Uji lifecycle nyata hanya di runner Docker sekali pakai. Modul produksi/staging reguler masih memasang callback **node kosong saja**; fixture lifecycle tidak dipakai oleh `npm run api`.

**Hasil lifecycle:** [GitHub Actions 45351010858](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45351010858) lulus. Daemon asli menerima create, meminta konfigurasi dan skrip, melaporkan instalasi berhasil, mencapai `running` lalu `offline`, dan menolak pembacaan UUID setelah delete. Job identitas MySQL dan verifikasi frontend/codec juga lulus. Tahap 3 masih terbuka: penyimpanan node/server/alokasi/egg/nest, UI dan API admin yang berizin, reinstall, transfer, websocket, serta callback SFTP/backup/aktivitas belum terverifikasi.

## Katalog admin persisten (staging)

Migrasi `002_catalog` menambahkan node, nest, egg, alokasi, dan server draft. Satu alokasi hanya dapat dipakai satu server, dan foreign key gabungan mencegah pemilihan alokasi dari node lain. Draft **tidak dikirim ke Wings**. API remote untuk Wings reguler masih mengembalikan inventaris kosong jika mode uji diaktifkan; jangan arahkan node lama atau node dengan data nyata ke sana.

- `api/catalog/routes.ts`, `api/app.ts`, `api/policy.ts`: rute admin hanya menerima sesi admin penuh, bukan API key. Penulisan dan audit dilakukan dalam satu transaksi. Daftar dibatasi 100 entri per jenis; belum ada pagination, edit, delete atau UI admin.
- `api/security.ts`, `.env.staging.example`, `api/server.ts`: token node dienkripsi dengan AES-256-GCM, kunci berbeda dari TOTP, dan AAD terikat UUID node. Token maupun verifier tidak dikembalikan melalui API. Asal koneksi wajib loopback dan cocok persis dengan `RELAY_CATALOG_NODE_ORIGIN` yang diset operator. Kunci node disimpan terpisah dari backup; jangan menggantinya tanpa migrasi re-enkripsi.
- `migrations/002_catalog.{up,down}.sql`, `api/migrate.ts`: migrasi kedua dengan ledger dan lock; `down` yang sudah ada membongkar seluruh skema staging dalam urutan terbalik. Jangan jalankan `down` pada staging berisi data penting tanpa backup dan persetujuan.
- `api/cli.ts`: provisioning admin staging eksplisit. `api/identity.integration.test.ts`: uji persistensi, proteksi sesi admin, larangan token API, audit, pemeriksaan health dengan HTTP fixture, serta isolasi alokasi.

Untuk mencoba, ikuti [setup Tahap 2](../stage-2/README.md), jalankan `npm run db -- up`, lalu buat akun admin staging dengan `RELAY_CONFIRM_ADMIN=create-staging-admin npm run db -- create-admin operator@example.test` dan masukkan kata sandi melalui stdin. Login melalui API, lalu akses `/api/v1/admin` menggunakan sesi dan header mutasi dari panduan Tahap 2.

| Rute | Operasi |
|---|---|
| `/nodes` | Daftar; buat `{name,origin,tokenId,token}` setelah mengisi `RELAY_NODE_KEY` dan origin uji persis. |
| `/nodes/{id}/health` | GET kesehatan langsung pada node yang masuk daftar izin. |
| `/nests` | Daftar; buat `{name}`. |
| `/eggs` | Daftar; impor `{nestId,document}` (`document` adalah teks JSON PTDL). |
| `/eggs/{id}/document` | GET unduh dokumen versi asli. |
| `/allocations` | Daftar; buat `{nodeId,ip,port}` dengan IP `127.0.0.1`. |
| `/servers` | Daftar; simpan draft `{name,nodeId,ownerId,eggId,allocationId}`. |

`npm run test:identity` menjalankan tes non-DB lokal. Untuk skenario MySQL aktifkan `RELAY_RUN_MYSQL_TESTS=1` dan gunakan **hanya** basis data sekali pakai `relay_test` atau job `identity` di CI. Uji health katalog dengan HTTP fixture tidak membuktikan bahwa katalog telah terhubung ke lifecycle Wings nyata.
