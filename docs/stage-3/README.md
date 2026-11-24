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

**Hasil katalog:** [GitHub Actions 45352026287](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45352026287) lulus ketiga job. Integrasi MySQL mencakup migrasi ulang tanpa kehilangan draft, penolakan sesi non-admin dan API key admin, token node terenkripsi dan tidak terserialisasi, ekspor byte-identik, penolakan alokasi lintas node/duplikat, dan audit. Job Wings tetap menguji lifecycle fixture secara terpisah, bukan provisioning draft dari katalog.

## Provisioning draft yang terhubung ke Wings

Migrasi `003_provision` menyimpan fase dispatch terpisah dari draft. Mode ini **mati secara default**. Untuk lab sekali pakai, harus ada `RELAY_ENABLE_DISPOSABLE_PROVISIONING=1`, pasangan token node uji, `RELAY_NODE_KEY`, dan origin loopback yang sama persis dengan `RELAY_CATALOG_NODE_ORIGIN`. Mode ini hanya menerima dokumen fixture yang identik dengan `disposableEgg` di `api/wings/provision.ts` dan menggunakan image runtime lokal buatan skrip CI. Script dan image dari egg lain tidak dieksekusi. Jangan mengaktifkannya untuk node lama atau node staging yang menyimpan workload nyata.

- `POST /api/v1/admin/servers/{id}/provision` dengan `{ "confirm": true }` mengambil sesi admin, mengunci draft dan menulis `dispatching` serta audit sebelum memanggil Wings. Permintaan ulang mendapat `409` dan tidak mengulang create.
- `GET /api/v1/admin/servers/{id}/provision` membaca fase. `installing` artinya Wings menerima request; hanya callback bertoken node yang menetapkan `installed` atau `install_failed`. Callback terminal tidak ditimpa oleh respons dispatch atau callback terlambat. Callback dicatat di audit tanpa payload sensitif.
- Error/timeout dispatch ditandai `uncertain`; kegagalan proses yang mendadak dapat menyisakan `dispatching`. Tidak ada retry otomatis karena daemon bisa sudah membuat server. Untuk lab, inspeksi daemon pada UUID yang sama dan arsipkan hasil sebelum mereset lingkungan sekali pakai. Belum ada jalur rekonsiliasi operator atau cleanup yang menyinkronkan katalog secara otomatis.
- Remote API hanya melayani workload fixture pada pasangan kredensial yang terdaftar. Daftar bootstrap memuat fixture `installed` saja, bukan draft atau dispatch yang belum pasti. Ini bukan strategi adopsi node lama.

Berkas utama: `api/wings/provision.ts`, `api/wings/remote.ts`, `api/catalog/routes.ts`, `api/app.ts`, `api/server.ts`, migrasi `003_provision`, dan pengujian di `api/wings/live-contract.ts` serta `api/identity.integration.test.ts`. Jalankan `npm run test:wings` dan `npm run test:identity` untuk uji lokal; job `wings-bootstrap` memakai MySQL dan daemon dalam runner Docker sekali pakai. Start/stop/delete pada harness masih memanggil adaptor daemon, bukan endpoint admin publik. Tahap 3 belum ditutup.

**Hasil provisioning terintegrasi:** [GitHub Actions 45354124135](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45354124135) lulus. Job Docker membuat draft lewat sesi admin, mengirim dua permintaan provisioning serentak (satu `202`, satu `409`), lalu memperoleh status `installed` dari daemon nyata dan menguji start/stop/delete melalui adaptor. Job MySQL terpisah menguji bahwa dispatch yang tidak pasti tidak dikirim ulang, callback tanpa token ditolak, dan callback gagal dari node yang sah tersimpan sebagai `install_failed`. Network Docker internal tersendiri menghindari benturan subnet default Wings dengan layanan MySQL runner.

## Kontrol runtime dan pemeriksaan dispatch

Rute berikut ditambahkan ke `/api/v1/admin`, hanya dalam mode fixture sekali pakai. Semuanya memerlukan sesi admin; request mutasi juga mengikuti pemeriksaan origin/CSRF dari Tahap 2.

| Rute | Perilaku |
|---|---|
| `GET /servers/{id}/runtime` | Membaca state Wings untuk fixture terinstal. Memeriksa UUID respons dan membedakan `present`, `absent` (HTTP 404), dan `unreachable`. |
| `POST /servers/{id}/power` | Dengan `{ "action": "start" atau "stop", "confirm": true }`. Audit dicatat sebelum pengiriman. HTTP `202` berarti daemon menerima perintah, bukan state sudah berubah. Kegagalan pengiriman tidak diulang otomatis. |
| `POST /servers/{id}/reconcile` | Dengan `{ "confirm": true }`; observasi untuk `dispatching`, `installing`, dan `uncertain`. Mencatat hasil di audit tanpa mengirim `create` ulang atau menandai instalasi sukses. |

Pemeriksaan kehadiran daemon tidak bisa memastikan hasil instalasi. Jika callback hilang, status tetap sesuai catatan terakhir; belum ada mekanisme reset/force retry otomatis. API delete/reinstall/transfer serta integrasi websocket masih terpisah dari rute admin. `api/wings/{client,provision,live-contract}.ts`, `api/catalog/routes.ts`, dan `api/identity.integration.test.ts` memuat perubahan dan tes. Jalankan `npm run test:wings` dan periksa job `identity` serta `wings-bootstrap` untuk MySQL dan daemon nyata.

**Hasil kontrol runtime:** [GitHub Actions 45355558549](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45355558549) lulus ketiga job. Harness start dan stop sekarang melalui API admin, dengan polling state melalui rute runtime dan verifikasi daemon asli. Uji MySQL memverifikasi bahwa pengguna biasa ditolak, konfirmasi wajib, dan rekonsiliasi outage tidak membuat dispatch kedua atau mengubah `uncertain` menjadi sukses. Penghapusan harness masih langsung melalui adaptor untuk cleanup lingkungan uji.

## Reinstall dan delete dari API admin

`POST /api/v1/admin/servers/{id}/reinstall` dan `/delete` memerlukan sesi admin, origin/CSRF yang sah, dan body `{ "confirm": true }`. Rute hanya terdaftar dalam mode fixture. Relay menolak aksi jika daemon tidak bisa memastikan server `offline`; fase dan audit dicatat sebelum memanggil Wings. Pengiriman untuk server yang sama diserialkan dalam proses staging tunggal. Ini bukan penguncian multi-instans.

- Reinstall masuk `reinstalling`; callback yang memang bertanda `reinstall` menentukan `installed` atau `install_failed`. Dispatch yang tidak pasti ditandai `reinstall_uncertain` tanpa retry otomatis.
- Delete masuk `deleting`; `deleted` berarti Wings mengonfirmasi penghapusan server dari manajernya, bukan bukti bahwa seluruh file sudah hilang. Katalog mempertahankan entri sebagai riwayat, alokasi tidak dibebaskan, dan server tidak diterbitkan ulang saat Wings boot. Timeout masuk `delete_uncertain`; observasi tidak otomatis menyelesaikannya.
- Migrasi `004_lifecycle` menambah fase tersebut. Untuk migrasi staging jalankan `npm run db -- up`. Rollback skema penuh tetap menghapus data staging; pada langkah penurunan versi fase baru dipetakan ke `uncertain`, bukan `installed`.

Berkas: `api/wings/{client,provision,live-contract}.ts`, `api/catalog/routes.ts`, `api/identity.integration.test.ts`, `api/migrate.ts`, `migrations/004_lifecycle.{up,down}.sql`. Tes lokal: `npm run test:wings`. Integrasi API → MySQL → daemon asli dijalankan job `wings-bootstrap`.

**Hasil:** [GitHub Actions 45358544003](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45358544003) lulus. Daemon asli menolak tahap destruktif melalui pemeriksaan Relay ketika fixture masih berjalan; sesudah stop, tes memverifikasi callback reinstall kedua, penghapusan dari Wings, penolakan delete ulang, dan tidak ada UUID terhapus dalam daftar bootstrap. Job MySQL juga lulus untuk penolakan non-admin dan fase `uncertain`.

## Websocket Wings: snapshot statistik dari backend

`GET /api/v1/admin/servers/{id}/stats` tersedia hanya pada mode fixture yang terinstal dan dengan sesi admin. Backend membuka websocket ke origin node loopback yang dipatok, menerbitkan JWT HS256 berumur 30 detik yang terikat server dan pengguna, lalu mengirim `auth` dan `send stats`. Satu respons statistik dipilah menjadi angka CPU, memori, disk, uptime, dan jaringan; socket ditutup sesudahnya. Browser tidak menerima JWT, token node, log, atau alamat socket internal. Izin JWT hanya `websocket.connect`; fasilitas ini tidak mengirim perintah konsol atau power melalui socket.

Koneksi dibatasi empat secara bersamaan per proses, 15 request per menit pada rute, 32 KiB per frame, dan 5 detik keseluruhan. Redirect dan kompresi websocket tidak digunakan. Wings harus menerima origin panel yang tepat; skrip CI mengatur daftar izin tanpa wildcard.

Berkas: `api/wings/socket.ts`, `api/wings/socket.test.ts`, integrasi di `api/wings/provision.ts`, `api/catalog/routes.ts`, `api/app.ts`, tes di `api/wings/live-contract.ts` dan `api/identity.integration.test.ts`, `scripts/wings-contract.sh`, serta lockfile untuk `ws`. Jalankan `npm run test:wings`. Ini belum menjadi stream konsol browser: belum ada replay log, panggilan command, refresh/revoke untuk koneksi berumur panjang, atau integrasi dashboard. Transfer dan adopsi node tetap belum selesai.

**Hasil:** [GitHub Actions 45360974612](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45360974612) lulus ketiga job. Daemon asli menerima JWT dari backend dan mengembalikan snapshot statistik; koneksi dengan origin berbeda ditolak. Integrasi MySQL memverifikasi penolakan non-admin dan fixture yang belum terinstal. Lima tes Wings lokal lulus.

## Replay konsol fixture dan rediscovery saat Wings restart

`GET /api/v1/admin/servers/{id}/console` adalah snapshot khusus fixture, bukan konsol umum. Backend memakai capability server-side yang sama seperti stats, menunggu `auth success`, lalu mengirim `send logs`. Relay hanya mempublikasikan marker `RELAY_CONTRACT_READY` yang ditulis fixture; baris lain dibuang seluruhnya (bukan klaim penyamaran rahasia umum). Hasil dibatasi 20 marker dan mencakup `truncated`. Tidak ada token atau alamat socket internal dalam respons. Server offline tanpa replay menghasilkan daftar kosong; idle 350 ms adalah jendela pengambilan, bukan tanda dari Wings bahwa seluruh log selesai. Tidak ada streaming browser, command, atau log umum.

Harness Docker juga me-restart **container Wings** sementara container workload terus berjalan. Tes membandingkan ID Docker dan `StartedAt` sebelum/sesudah, memeriksa status server dari daemon yang kembali dan memastikan tidak muncul callback instalasi tambahan. Ini hanya menguji rediscovery satu workload yang sudah terdaftar di Relay, **bukan** perpindahan dari instalasi Panel lama atau adopsi volume produksi.

Berkas berubah: `api/wings/socket.ts`, `api/wings/socket.test.ts`, `api/wings/provision.ts`, `api/catalog/routes.ts`, `api/identity.integration.test.ts`, dan `api/wings/live-contract.ts`. Jalankan `npm run test:wings` untuk unit/socket fixture; job `wings-bootstrap` menjalankan daemon dan MySQL sebenarnya.

**Hasil:** [GitHub Actions 45362872328](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45362872328) lulus ketiga job. Real Wings mengembalikan marker saat workload berjalan dan snapshot kosong sebelum start. Workload tetap `running`, dengan ID Docker dan waktu start yang sama setelah restart daemon; jumlah instalasi tidak berubah saat rediscovery. Enam tes lokal Wings lulus, termasuk penghapusan baris yang tidak diizinkan dan batas 20 baris.

## Kontrak transfer dua daemon

Harness `api/wings/live-transfer.ts` dan `scripts/wings-transfer-contract.sh` menjalankan dua Wings versi 1.13.5 dengan Docker Engine, direktori data, alokasi, dan kredensial berbeda. Engine tujuan berjalan secara nested dengan socket Unix privat, hanya pada runner GitHub sekali pakai; jangan jalankan di host bersama. Node memakai loopback, fixture tidak memuat data atau kredensial produksi, dan workload tidak punya egress dari network Docker internal.

Adaptor `api/wings/client.ts` mengirim permintaan transfer ke path tetap pada sumber; `api/wings/transfer-token.ts` membuat JWT singkat dengan secret tujuan, `scope=transfer`, dan UUID fixture di `sub`. Callback scoped di `api/wings/remote.ts` hanya dipasang eksplisit oleh harness. Kriteria uji: tujuan menolak JWT yang ditandatangani sumber, callback dengan kredensial sumber ditolak pada rute tujuan, tujuan melaporkan sukses untuk UUID yang diharapkan, dan checksum file fixture pada tujuan sama dengan sumber. Sumber tidak dihapus sebelum pemeriksaan. `npm run test:wings` menjalankan unit test termasuk konstruksi permintaan; job `wings-transfer` menjalankan daemon nyata.

Ini **bukan** endpoint transfer pengguna: belum ada reservasi alokasi tujuan, pembaruan kepemilikan server di MySQL, cancel/retry, atau pemulihan setelah timeout. Selesainya transfer fixture tidak membuktikan bahwa node dari Panel lama bisa langsung diadopsi.

**Hasil:** [GitHub Actions 45363697177](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45363697177) lulus empat job. Dua daemon asli pada engine berbeda memverifikasi pemindahan arsip fixture, isolasi kredensial sumber/tujuan, checksum file cocok, serta file sumber masih tersedia sebelum cleanup. Delapan tes Wings lokal lulus. Job pertama terhenti karena akses runner ke socket engine tujuan; perbaikan membatasi engine ke socket Unix privat dan memakai `sudo` noninteraktif pada runner sekali pakai, tanpa membuka API Docker melalui TCP.
