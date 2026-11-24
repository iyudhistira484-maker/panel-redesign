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

### Reservasi dan perubahan penempatan di MySQL

Migrasi `005_transfer` dan `api/catalog/transfer.ts` mencatat sumber dan tujuan serta mengunci satu transfer aktif per server dan satu reservasi per alokasi tujuan. Pembuatan draft memakai kunci baris alokasi yang sama. Selama reservasi, server tetap tercatat pada sumber dan fase `transferring` menolak operasi lifecycle yang mensyaratkan `installed`. Konfirmasi internal dengan identitas tujuan dan UUID yang cocok memperbarui node dan alokasi dalam satu transaksi. Pembatalan sebelum dispatch membebaskan reservasi; hasil ambigu mempertahankannya dan menolak penyelesaian otomatis. Jangan rollback staging jika ada transfer yang belum direkonsiliasi: migrasi turun menghilangkan riwayat reservasi dan menandai provisioning terkait `uncertain`.

Ledger belum dipanggil oleh API transfer atau callback Wings. Tes MySQL memanggil ledger langsung dengan hasil simulasi; job `wings-transfer` terpisah menguji pengiriman arsip asli. Langkah berikutnya menghubungkan keduanya dengan dispatch tahan restart, verifikasi tujuan, dan rekonsiliasi sebelum penghapusan sumber.

**Hasil MySQL 8.4:** [CI 45364202182](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45364202182) lulus empat job. Tes memastikan dua permintaan serentak menghasilkan satu reservasi, draft tidak dapat mengambil alokasi tersebut, konfirmasi dari identitas node yang keliru tidak memindahkan server, konfirmasi ulang tidak mengubah data, hasil ambigu tetap terkunci, dan migrasi naik–turun–naik lulus. Untuk menjalankan tes gunakan `RELAY_RUN_MYSQL_TESTS=1 npm run test:identity` dengan konfigurasi staging dan database sekali pakai `relay_test`; tes menghapus dan membangun ulang skema.

### Transfer fixture terintegrasi MySQL dan Wings

Sejak migrasi `006_transfer_dispatch`, harness dua daemon juga memakai MySQL 8.4. Sebelum permintaan dikirim, satu claim dicatat secara atomik; claim kedua dan pembatalan sebelum dispatch ditolak setelah itu. Rute callback terautentikasi node mencatat laporan sukses tujuan. Laporan ini diperlukan tetapi tidak cukup untuk cutover: harness juga memeriksa server offline di tujuan, mencocokkan checksum file, dan memastikan sumber masih dapat dibaca sebelum mengubah penempatan katalog. Pembersihan daemon tetap teardown fixture, bukan penghapusan sumber otomatis pada transfer pengguna.

[CI 45364711857](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45364711857) lulus seluruh job. Jalankan `npm run test:wings` untuk unit test; job `wings-transfer` menjalankan kontrak gabungan pada runner sekali pakai. Claim dan laporan persisten belum menggantikan tes restart proses di tengah dispatch, rekonsiliasi timeout, atau verifikasi dan pembersihan sumber oleh layanan aplikasi. Belum ada route transfer pengguna, adopsi Panel lama, atau eksekusi generik egg impor.

### Transfer tanpa konfirmasi setelah proses berhenti

`expireUnconfirmedDispatches()` memindahkan maksimal 100 dispatch berumur minimal lima menit tanpa laporan tujuan ke `uncertain` per pemanggilan. Operasi ini tidak membuka reservasi, mengirim ulang, mengubah penempatan, atau menghapus sumber. Laporan yang tiba setelah karantina tidak menyelesaikan transfer. Jika laporan tujuan sudah tersimpan, transfer tidak masuk karantina ini: penempatan masih menunggu verifikasi tujuan. Fungsi belum dijadwalkan oleh aplikasi. Tes MySQL memakai koneksi baru untuk mensimulasikan pembacaan ulang status persisten, bukan mematikan proses Wings saat pengiriman berlangsung.

Urutan penyelesaian yang disarankan: selesaikan verifikasi dan rekonsiliasi transfer fixture termasuk restart proses sungguhan; uji adopsi dari instalasi Panel lama yang dibuat khusus di staging; lalu uji eksekusi egg impor yang representatif. Adopsi pertama tidak memerlukan data produksi. Untuk rehearsal dengan salinan produksi pada tahap yang disetujui, konfirmasi backup dan uji restore lebih dahulu; jangan kirim kredensial atau `APP_KEY` lewat chat.

[CI 45365334753](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45365334753) lulus empat job, termasuk tes koneksi baru di MySQL 8.4 dan kontrak dua daemon Wings.

### Melanjutkan transfer setelah listener callback ditutup

Harness menghentikan listener callback setelah sukses tujuan tercatat, sebelum katalog dipindah. Proses Node baru membuka koneksi MySQL terpisah, membaca klaim dan laporan yang persisten, memastikan klaim tidak bisa digunakan lagi, memeriksa status offline tujuan serta checksum sumber/tujuan lewat dua daemon Wings, lalu menyelesaikan perubahan penempatan. Proses baru mendapat ID transfer dan checksum fixture acuan dari harness; ini belum discovery otomatis oleh worker. Skenario ini menguji pemulihan **setelah** callback tersimpan, bukan proses mati selama pengiriman arsip atau saat callback belum mencapai Relay.

[CI 45366407844](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45366407844) lulus empat job, termasuk pemulihan pada proses terpisah dengan MySQL 8.4 dan dua daemon Wings v1.13.5. Jalankan kontrak melalui job `wings-transfer`; jangan menjalankan skrip pada host bersama.

### Arsip diterima tanpa laporan tujuan yang tersimpan

Job `wings-transfer` kini menguji `reported` dan `missing-report` di runner terpisah. Pada skenario kedua, dua daemon memindahkan arsip fixture sungguhan; listener sengaja menolak callback sukses sebelum menulisnya. Koneksi MySQL baru menjalankan karantina setelah jam dispatch dimundurkan di database uji. Tes memeriksa bahwa hasil tetap `uncertain`, alokasi tidak dilepas, katalog masih menunjuk sumber, klaim ulang dan laporan terlambat ditolak, serta checksum kedua salinan cocok. Cleanup hanya dilakukan setelah pemeriksaan. Ini injeksi kegagalan callback, bukan penghentian paksa proses saat upload berlangsung. [CI 45373445366](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45373445366) lulus lima job.

### Pengirim Wings dihentikan saat koneksi upload masih terbuka

`wings-transfer (sender-killed)` menunggu penerima loopback khusus menerima potongan pertama dari upload nyata Wings, menahan koneksi tanpa respons, lalu melakukan `SIGKILL` pada container Wings sumber sekali pakai. Penerima ini tidak meneruskan arsip ke Wings tujuan, sehingga skenario tidak membuktikan cleanup arsip parsial pada node tujuan. Tes memastikan tujuan tidak memiliki UUID, koneksi MySQL baru mengarantina klaim kedaluwarsa tanpa melepas alokasi atau mengubah katalog, klaim ulang ditolak, dan Wings sumber setelah start ulang menemukan UUID dengan checksum file yang sama. Waktu tunggu disimulasikan dengan mengubah timestamp fixture, bukan menunggu lima menit. [CI 45373981246](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45373981246) lulus enam job. Jalankan melalui workflow runner sekali pakai, bukan VPS bersama.

### Upload terpotong setelah Wings tujuan mulai memproses transfer

`wings-transfer (partial-target)` meneruskan potongan awal body multipart melalui proxy loopback ke Wings tujuan asli. Harness menunggu Wings tujuan meminta konfigurasi UUID, menghentikan container Wings sumber, lalu memutus koneksi upstream. Wings tujuan mengirim callback gagal; tes memeriksa bahwa UUID tidak ada di registri tujuan dan direktori volume UUID tidak tertinggal. Relay tetap mengarantina transfer dengan alokasi terkunci dan katalog menunjuk sumber; setelah Wings sumber hidup kembali, checksum file sumber cocok. Skenario ini menguji pemutusan awal stream, bukan arsip besar yang sudah diekstrak sebagian atau seluruh kemungkinan titik kegagalan. [CI 45374365515](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45374365515) lulus tujuh job. Jalankan melalui workflow runner sekali pakai.

### Status dan karantina transfer khusus admin staging

- `GET /api/v1/admin/servers/{id}/transfer`: status transfer aktif, identitas sumber/tujuan, alokasi, dan indikator klaim/laporan. Tidak menyertakan kredensial; `Cache-Control: no-store`; 404 jika tidak ada transfer aktif.
- `POST /api/v1/admin/servers/{id}/transfer/reconcile` dengan JSON `{"confirm":true}`: hanya mengarantina klaim tanpa laporan yang telah melewati lima menit untuk UUID yang diminta. Menghasilkan `409` jika belum memenuhi syarat. Autentikasi sesi admin dan aturan CSRF katalog tetap berlaku; role dicek lagi dalam transaksi yang sama dengan karantina dan audit `catalog.transfer_quarantined`.

Tidak ada pengiriman, percobaan ulang, pelepasan alokasi, pemindahan katalog, atau cleanup melalui kedua endpoint ini. [CI 45374942303](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45374942303) lulus tujuh job; `RELAY_RUN_MYSQL_TESTS=1 npm run test:identity` memverifikasi kontrak admin pada database staging sekali pakai `relay_test`. Dispatch transfer dari API dan verifikasi otomatis oleh layanan aplikasi masih terbuka.

### Layanan internal dispatch dan verifikasi fixture

`api/wings/transfer-service.ts` menolak penempatan yang tidak cocok dengan dua endpoint staging yang disediakan pemanggil dan hanya mengirim fixture offline. Migrasi `007_transfer_digest` menyimpan checksum file startup bersama klaim atomik sebelum panggilan Wings. Proses pemulihan menerima ID transfer saja, membaca laporan sukses dan checksum dari MySQL, memeriksa server tujuan offline dan checksum sumber/tujuan, lalu menyelesaikan perubahan katalog. Transfer lama tanpa checksum tidak dapat diselesaikan lewat layanan ini. Hasil dispatch ambigu dikarantina tanpa retry. Tidak ada penghapusan sumber oleh layanan.

Kontrak dijalankan melalui matriks `wings-transfer`. Layanan belum dipasang ke endpoint untuk memulai transfer: resolusi node dan alokasi serta otorisasi admin untuk dispatch aplikasi masih perlu dihubungkan dan diuji. Validasi checksum hanya mencakup satu file fixture, bukan pemeriksaan semua file workload umum.

[CI 45375703704](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45375703704) lulus tujuh job, termasuk dispatch, pemulihan proses terpisah, dan tiga skenario gagal. Lint dan build lokal lulus.

### Endpoint dispatch fixture di harness staging

`POST /api/v1/admin/servers/{id}/transfer` menerima `{"confirm":true,"nodeId":"<uuid>","allocationId":"<uuid>"}` hanya bila instans katalog diberikan konfigurasi fixture eksplisit. Harness sekali pakai mengaktifkannya untuk tepat satu UUID, node sumber, node tujuan, dan alokasi tujuan. Reservasi serta audit `catalog.transfer_reserved` dilakukan dalam satu transaksi setelah cek ulang role admin. Pengiriman dilakukan setelah commit dan mengembalikan `202` setelah Wings menerima permintaan, bukan setelah transfer berhasil. Gagal sebelum klaim dapat membatalkan reservasi; hasil ambigu setelah klaim tidak melepasnya. Tidak ada penghapusan sumber otomatis.

Matriks `wings-transfer` memakai route ini untuk memulai keempat skenario dengan MySQL dan Wings asli. Harness menyuntikkan identitas admin fixture; ini bukan uji sesi/cookie/CSRF end-to-end untuk route dispatch. `createApp()` tidak mengaktifkan route dispatch; endpoint ini belum tersedia di deployment panel biasa. Finalisasi masih dijalankan oleh proses pemulihan harness, bukan worker aplikasi.

[CI 45376735070](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45376735070) lulus tujuh job. Keempat skenario memverifikasi 401 tanpa autentikasi, 404 untuk node di luar fixture, 202 untuk dispatch valid, 409 untuk pengulangan, dan satu entri audit reservasi. Lint dan build lokal lulus.

### Uji sesi dan CSRF pada endpoint dispatch fixture

`createApp()` kini dapat menerima konfigurasi fixture transfer secara eksplisit hanya bersama `enableDisposableProvisioning`. Entrypoint server biasa tidak menyuplai konfigurasi tersebut. Tes aplikasi menggunakan cookie sesi asli dan MySQL: tanpa sesi, non-admin, origin yang salah, dan tanpa `X-Relay-Request` semuanya ditolak sebelum fungsi dispatch dipanggil. Admin valid mencapai adaptor uji; ketika adaptor menolak sebelum klaim, reservasi berakhir `cancelled`. Tes ini memakai adaptor mock agar terisolasi; matriks Wings terpisah tetap menguji pengiriman arsip sungguhan.

[CI 45377186553](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45377186553) lulus tujuh job. Ulangi tes sesi dengan `RELAY_RUN_MYSQL_TESTS=1 npm run test:identity` hanya pada `relay_test` sekali pakai.

### Finalisasi transfer fixture melalui API admin

`POST /api/v1/admin/servers/{id}/transfer/finalize` dengan `{"confirm":true,"transferId":"<uuid>"}` tersedia hanya saat konfigurasi fixture juga menyediakan layanan finalisasi. Route menolak laporan yang tidak cocok dengan UUID server, node sumber/tujuan, dan alokasi yang diizinkan. Layanan memverifikasi tujuan dan checksum fixture sebelum commit. Role admin dicek ulang di transaksi yang sama dengan perpindahan katalog dan audit `catalog.transfer_completed`. Tidak ada penghapusan sumber, percobaan ulang, atau finalisasi transfer `uncertain`.

Skenario `reported` menutup listener callback dan menguji API pada proses baru dengan MySQL dan dua Wings asli. Autentikasi finalisasi di harness memakai identitas fixture; server biasa tetap tidak mengaktifkan dispatch/finalisasi. Ini bukan worker otomatis atau fitur transfer umum.

[CI 45377616408](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45377616408) lulus tujuh job. `wings-transfer (reported)` memeriksa permintaan tanpa autentikasi, UUID transfer tidak dikenal, role sudah dicabut, finalisasi sukses, pengulangan ditolak, dan audit tunggal. Lint dan build lokal lulus.

### Simulasi cutover dan rollback remote Wings

`wings-bootstrap (adoption)` membuat workload pada Wings nyata yang awalnya memakai controller sumber terpisah berbasis kontrak remote Panel v1.15.2. Setelah workload berjalan, harness membuat data fixture di MySQL Relay dengan UUID, alokasi, dan kredensial node yang sama. Harness menyalin konfigurasi dan hanya mengganti `remote`, me-restart daemon Wings tanpa memasang ulang atau menghentikan container workload, lalu memulihkan file konfigurasi asal untuk rollback. Di kedua arah UUID, ID Docker, `StartedAt`, dan checksum file startup tetap sama. Tidak ada instalasi kedua. **Controller sumber adalah simulasi, bukan aplikasi PHP Pterodactyl Panel;** penempatan MySQL dibuat oleh harness, bukan importer dump. Uji ini bukan rehearsal salinan produksi atau bukti kompatibilitas semua egg.

[CI 45378095696](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45378095696) lulus delapan job. Untuk mengulang gunakan job `wings-bootstrap (adoption)` pada runner sekali pakai. Jangan menjalankan skrip ini pada VPS yang memiliki Wings produksi.

### Cutover dan rollback dari Pterodactyl Panel v1.15.2 asli

`wings-bootstrap (legacy-panel)` menjalankan image resmi `ghcr.io/pterodactyl/panel:v1.15.2` dengan database MariaDB `panel_adoption_fixture` terpisah dari MySQL Relay. Seeder pengujian membuat record Panel dengan token Wings terenkripsi menggunakan encrypter Laravel. Wings membaca konfigurasi dan skrip dari Panel asli; karena record fixture sudah masuk bootstrap, reinstall **persiapan** dijalankan di controller lama, sebelum baseline dicatat. Tes menunggu `installed_at` dan status normal dari database sumber sebelum menjalankan workload. Setelah baseline, hanya alamat `remote` yang diubah dan Wings direstart; tidak ada reinstall saat cutover atau rollback. UUID, ID dan `StartedAt` container, checksum file, dan status instalasi sumber tetap sama. Data Relay disiapkan oleh harness, bukan melalui importer; ini bukan bukti migrasi dump atau kompatibilitas MariaDB secara umum.

[CI 45379634097](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45379634097) lulus sembilan job. Dua percobaan awal menemukan klien schema loader mewajibkan TLS pada koneksi loopback dan bahwa UUID yang sudah dimuat lewat bootstrap tidak bisa dibuat ulang. Penyesuaian TLS hanya untuk klien di container fixture. Satu run sebelumnya juga mengalami rate limit pull Docker Hub pada skenario transfer terpisah. Jalankan hanya lewat runner sekali pakai; tidak ada kredensial atau data produksi yang diperlukan.

### Eksekusi egg HTTP impor PTDL v1 dan v2

`api/eggs/reviewed-workload.ts` memetakan dua dokumen HTTP yang diperiksa dan diizinkan berdasarkan byte persis. Pada mode provisioning disposable, kedua versi masuk lewat API katalog, diekspor kembali persis, lalu skrip instalasinya membuat halaman statis. Wings menghidupkan BusyBox HTTP dengan startup dari dokumen dan port alokasi. Harness mengirim request HTTP dari dalam container dan menguji stop serta delete. Workload memakai network internal, tanpa mount tambahan; konfigurasi runtime lain tetap berangkat dari fixture staging. Varian yang diubah, termasuk perubahan isi skrip, tidak memenuhi allowlist. Ini bukan izin menjalankan egg arbitrer atau bukti dukungan aturan variabel, config rewrite, image eksternal, maupun script komunitas.

[CI 45380944814](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45380944814) lulus sembilan job. Percobaan awal menemukan BusyBox HTTP perlu `busybox-extras` dan shell PID 1 perlu trap `SIGTERM` eksplisit supaya stop selesai. Ulangi unit dengan `npm run test:eggs` atau tes nyata melalui `wings-bootstrap (lifecycle)` pada runner disposable.

### Preflight metadata sumber sebelum cutover

Pada job `wings-bootstrap (legacy-panel)`, skrip fixture membaca enam tabel dari database Panel asli dalam satu transaksi baca dan hanya mengambil kolom yang diizinkan. `api/import/legacy-preflight.ts` memvalidasi jumlah baris, UUID unik, hubungan owner/node/nest/egg, kepemilikan alokasi dan port, serta bahwa server sudah terpasang dan tidak sedang beroperasi dalam fase instalasi/migrasi. Manifest tidak memuat password hash, token node, email, atau `APP_KEY`. Tes membandingkan UUID hasil pemetaan dengan penempatan yang diharapkan sebelum mengganti `remote` Wings. Pemeriksaan ini tidak menulis apa pun ke sumber maupun tujuan; penyiapan katalog fixture tetap terpisah, dan belum menerima dump SQL atau memeriksa izin subuser.

[CI 45382848809](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45382848809) lulus sembilan job. Jalankan `npm run test:identity` untuk tes preflight lokal (MySQL dilewati tanpa konfigurasi tes); job `wings-bootstrap (legacy-panel)` memeriksa manifest dari Panel asli.

### Apply idempoten untuk satu fixture adopsi

Pada skenario `legacy-panel`, katalog Relay kini dibentuk dari UUID dan relasi manifest yang divalidasi oleh `api/import/legacy-fixture-apply.ts`, bukan INSERT langsung oleh harness. Apply hanya berjalan pada GitHub runner disposable dan database `relay_test`. Satu transaksi menyimpan user placeholder tanpa login, nest, egg fixture, node dengan token terenkripsi, alokasi loopback, server dan status; tidak menyambungkan database Panel sumber. Replay dengan pemetaan dan token identik tidak menambah baris. Konflik origin node di tengah transaksi membatalkan seluruh perubahan; konflik alokasi pada replay ditolak tanpa mengganti record. Harness baru melakukan cutover dan rollback setelah pemeriksaan itu.

Ini apply khusus fixture, bukan importer dump umum: token uji disediakan terpisah, alokasi Relay dipetakan eksplisit, egg runtime tetap fixture yang diizinkan, dan kata sandi/izin/data pengguna lama tidak dimigrasikan.

[CI 45383391767](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45383391767) lulus sembilan job, termasuk konflik, rollback transaksi, replay idempoten, dan cutover/rollback Wings dari Panel asli. Jalankan `wings-bootstrap (legacy-panel)` untuk mengulang; jangan jalankan apply pada VPS.

### Preflight cakupan izin subuser

Manifest kini mencakup `subusers` dan hanya mengeluarkan ID relasi serta daftar izin. Preflight memetakan setiap grant ke UUID user/server yang tepat, menolak referensi yatim, grant kepada pemilik, pasangan duplikat, dan izin di luar daftar terpusat. Tes lokal memakai grant berisi data sintetis dan memastikan wildcard ditolak. Skenario Panel nyata memeriksa ekspor saat tabel subuser kosong. Apply fixture menolak manifest berisi grant, sehingga belum ada perubahan izin atau implementasi pengelolaan subuser Tahap 6.

[CI 45384418879](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45384418879) lulus sembilan job. Gunakan `npm run test:identity` untuk mengulang tes preflight secara lokal.

### Impor dan adopsi dua server sekaligus

Skenario `legacy-panel` kini membaca dua server yang berbeda dari Panel v1.15.2 asli. Keduanya berbagi satu node Wings, owner, dan nest, tetapi punya UUID server, egg, dan alokasi berbeda. Importer fixture menerapkan keduanya dalam satu transaksi. Konflik alokasi pada baris kedua membatalkan seluruh transaksi, termasuk server pertama yang sudah ditulis. Replay identik tidak menambah baris; replay dengan pemetaan alokasi berubah ditolak. Setelah apply, cutover dan rollback mempertahankan kedua UUID, ID Docker, `StartedAt`, checksum file, dan status instalasi sumber. Skenario ini tidak menguji impor lintas node atau dump umum.

[CI 45389518962](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45389518962) lulus sembilan job. Ulangi lewat `wings-bootstrap (legacy-panel)` pada runner disposable.

### Variabel runtime dan rewrite konfigurasi egg yang diperiksa

Migrasi `008_fixture_mode` menyimpan opsi `fixtureMode` yang hanya menerima `alpha` atau `beta`. Opsi ini hanya dapat dipakai dengan provisioning disposable aktif dan dokumen egg HTTP yang lolos allowlist byte persis. Jika tidak diberikan, nilai default dokumen dipakai. Adaptor meneruskan `RELAY_SITE_MODE` ke startup dan mengompilasi satu placeholder yang dikenali pada `site/settings.json` menjadi aturan parser JSON Wings. Tidak ada evaluasi ekspresi umum atau jalur file yang diambil dari permintaan pengguna.

Harness menguji default `alpha` dan override `beta`, serta penolakan nilai di luar daftar sebelum draft dibuat. HTTP menyajikan `runtime.txt` yang ditulis dari environment dan `settings.json` yang diubah Wings, sementara key lain tetap utuh. Keduanya tetap melalui install, start, stop, dan delete. Dukungan parser dan aturan variabel egg secara umum belum dibuktikan.

[CI 45392536934](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45392536934) lulus sembilan job. Jalankan `npm run test:eggs` untuk unit atau `wings-bootstrap (lifecycle)` untuk verifikasi runtime dan rewrite dengan Wings nyata.

### Impor dan adopsi lintas dua node

Skenario `legacy-panel` kini memakai dua daemon Wings v1.13.5 dengan UUID node, kredensial, port API/SFTP, dan direktori data yang berbeda pada satu Docker Engine CI. Masing-masing memulai satu workload di bawah Panel lama. Apply memetakan setiap UUID node ke kredensial uji terpisah. Konflik saat menulis alokasi server kedua membatalkan seluruh batch, termasuk kedua record node; replay identik tidak menambah data. Pada Relay, dua instans staging dengan database yang sama masing-masing melayani satu node: listing hanya memuat UUID milik node tersebut, permintaan UUID tetangga mendapat 404, dan kredensial node lain ditolak 401. Setelah cutover dan rollback, kedua workload tetap `running` dengan ID, waktu mulai, dan checksum uji tidak berubah.

[CI 45393105819](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45393105819) lulus sembilan job. Ulangi melalui `wings-bootstrap (legacy-panel)` pada runner disposable. Ini bukan deployment multi-node produksi, dukungan dump umum, atau proses impor akun/izin penuh.

### Alur transfer melalui aplikasi Relay dengan sesi asli

Matriks `wings-transfer` kini memakai `createApp()` untuk login admin, dispatch, status, karantina dan finalisasi, bukan autentikasi admin tiruan. Permintaan browser disimulasikan lewat injeksi HTTP Fastify dengan cookie sesi dan header CSRF. Callback daemon nyata masih ditangani listener fixture terpisah untuk memungkinkan injeksi kegagalan. Pada skenario sukses, proses aplikasi baru login ulang dan menyelesaikan transfer setelah memverifikasi checksum sumber/tujuan. Pada skenario gagal, instans aplikasi dibuka ulang dengan koneksi MySQL baru; admin membaca klaim yang masih tersimpan dan melakukan karantina melalui API. Tidak ada redispatch, pelepasan reservasi, atau penghapusan sumber oleh aplikasi. Entrypoint server biasa masih tidak memasang konfigurasi route fixture; ini bukan deployment staging mandiri atau UI transfer.

[CI 45397923283](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45397923283) lulus sembilan job. Ulangi lewat keempat job `wings-transfer` pada runner disposable.

### Callback tujuan pada aplikasi Relay staging

Opsi eksplisit `fixtureReceiver` pada `createApp()` memasang callback Wings di `/api/remote/servers/{uuid}/transfer/{result}` hanya bersama provisioning disposable. Auth node tetap wajib; route machine tidak menerima autentikasi sesi browser. UUID fixture, reservasi aktif setelah klaim, node tujuan, alokasi loopback, dokumen egg dan token node terenkripsi harus cocok. Konfigurasi server tujuan diambil dari katalog, bukan dari body callback. Sukses hanya menyimpan laporan; penempatan tetap menunggu finalisasi admin dan verifikasi file. Laporan ulang tidak membuat perubahan, dan laporan gagal tidak mengubah penempatan atau melepas reservasi.

Skenario `reported` menjalankan callback melalui listener aplikasi asli pada loopback; skenario gagal masih memakai injeksi fault di listener harness. Entrypoint `api/server.ts` biasa belum memuat konfigurasi receiver dan belum ada bundle deployment multi-node mandiri.

[CI 45398606059](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45398606059) lulus sembilan job. `wings-transfer (reported)` memverifikasi callback sumber ditolak 401, callback tujuan sebelum klaim atau duplikat ditolak 404, dan laporan tujuan yang valid dapat difinalisasi setelah proses admin dimulai ulang.

### Transfer dari entrypoint staging mandiri

`api/server.ts` membaca `RELAY_FIXTURE_TRANSFER_ROLE` (`off` secara default, `source` atau `destination` untuk pengujian). Gunakan database staging dan dua daemon loopback sekali pakai. Kedua instans memakai `RELAY_FIXTURE_TRANSFER_{SERVER,SOURCE,TARGET,ALLOCATION}` yang sama, serta `RELAY_NODE_KEY` dan `RELAY_TOKEN_PEPPER` yang sama untuk membuka token katalog; masing-masing memakai `RELAY_API_PORT`, `RELAY_WINGS_TEST_*`, dan `RELAY_CATALOG_NODE_ORIGIN` yang berbeda sesuai node lokal. `RELAY_ENABLE_EMPTY_WINGS_TEST_NODE` dan `RELAY_ENABLE_DISPOSABLE_PROVISIONING` harus eksplisit `1`. `RELAY_ORIGIN` harus origin HTTPS persis; CI berbicara HTTP hanya pada loopback dan memberi header origin uji. Startup gagal jika katalog, UUID, kredensial lokal, alokasi, atau egg tidak cocok. Tidak ada pengaturan ini untuk produksi.

Untuk pengulangan dari database kosong, jalankan workflow push `wings-transfer (reported)` dan `wings-transfer (missing-report)`, bukan skrip pada VPS bersama. Workflow menyemai data uji dan menjalankan proses `api/server.ts` asli. Pada jalur sukses, kedua peran memakai entrypoint ini; admin login lewat HTTP, tujuan menyimpan callback, proses sumber direstart, lalu admin memverifikasi dan menyelesaikan perpindahan. Pada jalur laporan hilang, proses sumber juga direstart, dan admin mengarantina lewat API; penolakan callback sengaja diinjeksi di sisi tujuan. Skenario pemutusan upload lain tetap memakai harness fault injection. Penghapusan kedua workload hanya teardown CI.

### Status penutupan Tahap 3

Transfer fixture, verifikasi restart, adopsi dua node dari Panel v1.15.2, dan runtime egg HTTP v1/v2 adalah bukti staging, bukan paritas fitur umum. Tahap 3 tetap terbuka: importer belum membaca dump Panel umum atau memigrasikan akun/secret/grant; engine egg belum menangani egg komunitas, parser, mounts, image eksternal, dan aturan variabel secara umum; transfer masih hanya satu fixture loopback dan tidak mendukung rekonsiliasi semua hasil ambigu atau cleanup sumber oleh aplikasi. Tidak ada persetujuan Tahap 4 atau langkah produksi.

[CI 45401636979](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45401636979) lulus sembilan job, termasuk kedua skenario proses mandiri. Lokal: lint, build, dan sembilan tes Wings lulus (`npm run test:wings`).

## Keputusan cakupan

Relay tetap mengejar [target pengganti Pterodactyl Panel dan gate penutupan Tahap 3](replacement-gate.md), bukan instalasi baru saja.

### Preflight dari salinan database Pterodactyl

[CI 45404841767](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45404841767) lulus semua sembilan job. Job `wings-bootstrap (legacy-panel)` menyalin database Panel v1.15.2 dengan `mariadb-dump --single-transaction` melalui pipe ke schema lokal terpisah `panel_snapshot_ci`. Relay membaca snapshot tersebut langsung dari MariaDB memakai transaksi read-only dan akun terpisah dengan `SELECT` per kolom. Manifest itu menjadi input adopsi dua node, termasuk pengujian replay, konflik dan rollback. Tidak ada dump yang disimpan sebagai artefak.

Untuk dry-run pada salinan uji yang sudah direstore, set `RELAY_ENV=staging` dan `RELAY_LEGACY_SNAPSHOT_URL` ke database loopback `panel_snapshot_*` memakai akun khusus dengan grants seperti di `scripts/legacy-snapshot-ci.sh`, lalu jalankan `npm run legacy:preflight`. CLI hanya menampilkan jumlah baris; tidak menyalin email, hash password, token, atau kunci. Pembacaan dibatasi 10.000 baris per tabel. Restore SQL bukan bagian dari CLI. Jangan restore dump tak tepercaya atau gunakan database produksi.

Ini membuktikan jalur baca snapshot nyata, bukan migrasi umum. Batas jumlah dua server sudah dilepas pada rehearsal katalog terbatas; lihat bagian terakhir untuk cakupan terbaru. Gate egg dan transfer workload umum juga tetap terbuka.

### Latihan impor akun dan subuser

Snapshot CI memuat satu pemilik, satu kolaborator yang memiliki `activity.read` dan `control.start` hanya di server pertama, dan satu akun tanpa akses. Importer fixture menulis ketiga identitas non-admin dengan kredensial dinonaktifkan, serta satu grant, dalam transaksi yang sama dengan adopsi katalog. Tidak ada password, 2FA, atau token Panel yang dipindahkan. Dry-run tetap hanya membaca snapshot. Relay menolak replay jika identitas atau grant yang tersimpan telah berubah, alih-alih menimpanya.

Pengujian memuat grant dari MySQL dan meneruskannya ke kebijakan Relay untuk mengecek izin yang diizinkan dan penolakan tindakan lain, server lain, atau pengguna lain. Bagian berikut menunjukkan pengujian aktivasi dan satu endpoint pengguna; migrasi umum tetap di luar cakupan latihan.

Bukti: [CI 45406521401](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45406521401), sembilan job lulus.

### Aktivasi akun dan otorisasi lewat API pengguna

Latihan adopsi juga menjalankan akun pemilik, kolaborator, dan pengguna tanpa akses lewat handler Fastify asli: login ditolak sebelum aktivasi, token reset dikirim ke transport in-memory CI, token hanya dapat dipakai sekali, lalu login berhasil dan menghasilkan cookie Secure/HttpOnly. Ini tidak menguji pengiriman SMTP produksi.

`GET /api/v1/servers/:id/activity` mengharuskan sesi pengguna. Pemilik, admin aktif, atau subuser dengan grant `activity.read` dapat membaca aktivitas server tersebut. CI menguji 200 dengan isi yang tepat, 401 tanpa sesi, dan 404 untuk pengguna tanpa akses, server lain, dan grant yang baru dicabut meski sesi masih aktif. Pengecekan grant dan pengambilan aktivitas memakai satu kueri SQL. Untuk pengujian izin `control.start` melalui API, lihat bagian berikut; ini bukan klaim paritas semua izin.

Bukti: [CI 45409988349](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45409988349), sembilan job lulus.

### Power subuser sampai runtime Wings

[CI 45412479433](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45412479433) lulus sembilan job. Job `wings-bootstrap (legacy-panel)` mengaktifkan subuser hasil impor dan mengirim `POST /api/v1/servers/:id/power` dengan sesi dan CSRF. `start` pada server yang diizinkan menghasilkan 202 dan Wings beralih dari `offline` ke `running`. `stop`, akses lintas server, pengguna tanpa grant, dan `start` setelah grant dicabut ditolak. Audit hanya mencatat satu dispatch dari API; workload tetap offline setelah percobaan pascapencabutan. Tes power dilakukan setelah pemeriksaan integritas cutover dan rollback agar perubahan runtime disengaja tidak mengubah baseline. Endpoint hanya aktif bila provisioning fixture staging diaktifkan; bukan klaim dukungan workload umum.

### Aktivasi lewat SMTP staging

[CI 45414845291](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45414845291) lulus sembilan job. Skenario `legacy-panel` sekarang menggunakan pengirim SMTP yang sama dengan entrypoint staging dan Mailpit v1.27.11 sekali pakai di loopback. Pengujian mengambil tautan dari isi email yang benar-benar diterima untuk masing-masing dari tiga akun hasil impor, memakai token sekali, memastikan replay ditolak, lalu login dan mengulang pemeriksaan batas akses hingga Wings. Token tetap berada di fragmen tautan dan tidak dicetak. Ini menggantikan transport in-memory pada latihan ini, bukan validasi SMTP produksi atau UI reset.

### Egg PTDL v2 dengan parser properties

[CI 45415410123](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45415410123) lulus sembilan job. Job `wings-bootstrap (lifecycle)` sekarang menjalankan egg HTTP ketiga dengan skrip instalasi berbeda dan parser Wings `properties`. Tes mengimpor dan mengekspor dokumen tanpa mengubah byte, menginstal, menjalankan workload, membaca marker lewat HTTP, memeriksa `mode=beta` dan `keep=true` pada `server.properties`, lalu menghentikan dan menghapus workload. Dua egg JSON sebelumnya tetap diuji. Eksekusi masih terbatas pada allowlist byte eksak; tes mutasi memastikan dokumen yang berbeda tidak lolos. Ini menambah cakupan parser, bukan dukungan umum untuk egg komunitas.

### Egg upstream Mumble

[CI 45419070957](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45419070957): sembilan job lulus. `wings-bootstrap (lifecycle)` mengimpor dan mengekspor egg Mumble Panel v1.15.2 dengan byte persis, memakai installer dan image yang dideklarasikan dokumen, memetakan INI dan `MAX_USERS` bawaan, menunggu marker `Server listening on` dan state `running`, lalu stop dan delete. Dokumen tidak ditulis ulang; SHA-256 menjaganya dari perubahan. Override fixture HTTP ditolak untuk Mumble sebelum provision; input variabel Mumble kustom belum didukung. Provenance ada di `THIRD_PARTY_NOTICES.md`. Belum ada egg upstream kedua atau transfer Mumble; test transfer masih menggunakan shell fixture. Image upstream masih berupa tag, bukan digest pin.

[CI 45421049327](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45421049327) menutup batas variabel Mumble di atas: admin staging dapat menetapkan `mumbleMaxUsers` saat membuat draft Mumble. CI menolak `100000`, `+25`, `25` dengan newline, dan `1e2` sebelum draft, lalu mengonfirmasi nilai valid `37` mencapai `users=37` di INI pada container Wings yang berjalan. Dua percobaan sebelumnya gagal pada pengambilan image dan waktu tunggu installer; run terbaru lulus seluruh job. Egg upstream kedua dan transfer workload upstream tetap belum dibuktikan.

### Impor batch katalog lebih dari dua server

[CI 45423134851](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45423134851) lulus semua sembilan job. Apply staging tidak lagi bergantung pada jumlah dua server, port tetap, satu pemilik, atau satu grant. Job `legacy-panel` memperluas salinan manifest dengan baris sintetis ketiga: dua pemilik, dua grant, serta server berbagi node dan egg. CI memverifikasi commit dan replay tanpa duplikasi, membersihkan batch sintetis, lalu tetap menjalankan konflik atomik, adopsi dua workload asli, aktivasi akun, uji izin, verifikasi file, dan rollback.

Batas saat ini: maksimal 100 server dalam batch khusus CI, Wings loopback, identitas non-admin dengan alamat `example.test` yang dipetakan eksplisit, dan dokumen shell yang direview. Alokasi tambahan, konfigurasi egg katalog umum, serta identitas produksi belum tercakup. Baris ketiga bukan server Wings yang dijalankan. Egg upstream kedua dan transfer workload non-shell belum memenuhi gate penutupan.

### Transfer workload HTTP yang direview

[CI 45423971690](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45423971690) lulus sembilan job. Empat skenario transfer kini memakai egg HTTP PTDL v2 dan dua daemon dengan Docker engine terpisah, bukan proses shell idle. Receiver memetakan ulang konfigurasi untuk alokasi tujuan. Jalur sukses memverifikasi marker dan checksum `site/index.html`, callback terautentikasi, dan restart Relay sebelum finalisasi. Jalur ambigu menjaga sumber dan reservasi tanpa replay. Ini verifikasi satu file saksi, bukan seluruh pohon file, dan konfigurasi staging masih membatasi satu server per pasangan instans.

Dua pemeriksaan tambahan belum lulus dan tetap terpisah dari jalur default: `RELAY_TRANSFER_CHECK_DESTINATION_RUNTIME=1` mencoba start/stop pascafinalisasi tetapi Docker bertingkat di runner gagal mendelegasikan cgroup v2; `RELAY_EXPERIMENTAL_GITEA=1` menguji egg upstream kedua, tetapi Wings belum mencapai state siap meskipun installer melapor selesai ([run diagnostik](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45425307023)). Keduanya bukan bukti kelulusan. Jangan aktifkan untuk produksi.
