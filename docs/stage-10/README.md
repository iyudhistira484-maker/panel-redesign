# Tahap 10 — Latihan pemulihan dan rollback staging

[CI 45620443543](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45620443543), [job legacy Panel](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45620443543/job/139226836284), lulus 14 job. Harness membuat dump konsisten MySQL, menghentikan kedua instance Relay, lalu mengimpor ke schema kosong `relay_test_recovery` pada layanan MySQL CI yang sama. Instance Relay baru memakai schema hasil restore dan Wings yang sama. Dump dibatasi ke runner disposable, disimpan sementara dengan izin privat, tidak diunggah, dan dihapus setelah latihan.

| Pengukuran fixture CI | Durasi |
| --- | ---: |
| Membuat dump | 146 ms |
| Dari penghentian Relay hingga pemeriksaan pemulihan lulus | 1.647 ms |
| Switch kembali ke Panel lama dan rediscovery Wings | 1.133 ms |
| Dari checkpoint dump selesai hingga penghentian Relay | 793 ms |

Durasi ini hanya berlaku untuk fixture kecil dan lingkungan CI, bukan target RTO/RPO produksi. Perubahan nama dan pencabutan grant setelah dump tidak ikut pulih: grant yang dicabut kembali berlaku dari snapshot. Sebaliknya perubahan byte file setelah dump masih ada karena volume Wings tetap hidup dan tidak di-restore. Backup database ini bukan backup volume; kehilangan host database tidak diuji; simulasi kehilangan volume dijelaskan di bawah.

Pemulihan mencocokkan UUID, ID Application, external ID, pemilik, node, alokasi, fase instalasi, grant, sesi dan akses Bearer sebelum/sesudah. Dua workload adopsi mempertahankan identitas dan waktu mulai container, tanpa reinstall, serta checksum dan byte file. Saat Wings menunjuk kembali ke Panel v1.15.2, server adopsi tetap dapat ditemukan. Server yang dibuat di Relay tetap tercatat di Relay dan tidak muncul di inventaris Panel lama; ini bukan migrasi balik.

Material yang disimpan terpisah dari dump: `RELAY_TOTP_KEY` (material enkripsi TOTP), `RELAY_TOKEN_PEPPER` (digest sesi/token/kunci), `RELAY_NODE_KEY` (enkripsi kredensial node), pasangan token dan token ID Wings yang cocok, serta konfigurasi origin, koneksi database dan endpoint Wings. Harness memakai kembali material yang sama dan tidak menulis nilainya ke dokumentasi atau artefak. Pemulihan bila kunci hilang atau dirotasi tetap di luar cakupan. Tidak ada perubahan VPS atau produksi.

## Simulasi kehilangan volume Wings

[CI 45623175919](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45623175919) lulus 14 job setelah mengulang job kualifikasi Forgejo; [job legacy Panel](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45623175919/job/139236409425) lulus pada percobaan pertama. Harness mematikan satu fixture, membuat tar volume (batas 1 MiB untuk fixture) dan dump database selama fixture masih quiescent, lalu mencatat digest SHA-256 tar. Tar dibatasi ke sumber lokal milik harness, bukan input arsip pengguna.

Salinan arsip yang sengaja dirusak ditolak sebelum root tujuan dibuat. Arsip valid dipulihkan ke root terpisah dengan database hasil restore, tanpa memberi workload akses ke volume sumber. Tes memeriksa mount Docker dan menjalankan pembacaan checksum dari dalam workload baru, serta memverifikasi UUID, alokasi, pemilik dan grant. Byte kembali ke checkpoint; perubahan pasca-backup tidak ikut muncul di volume pulih. Volume asli dan workload kedua tetap utuh selama latihan; mount fixture dikembalikan ke volume asal setelahnya. Ini simulasi di host CI yang sama, bukan kegagalan host fisik atau pemulihan backup off-site.

Pengukuran satu fixture: backup volume **66 ms**; ekstraksi hingga pembacaan dari workload **2.640 ms**, tidak termasuk restore database atau persiapan checkpoint. Bukan target RTO/RPO produksi.

**Keputusan:** layak melanjutkan pilot staging terisolasi dengan fixture dan data disposable. Tunda pilot produksi sampai backup off-host, kehilangan host database/node, ukuran workload representatif, dan prosedur operasional/otorisasi cutover diuji.

## Recovery lintas runner — fixture sintetis lulus

`scripts/relay-offhost-bundle.py` mengemas satu checkpoint database/volume dengan manifest SHA-256, tanda tangan sumber yang dipin, serta enkripsi CMS AES-256-GCM untuk sertifikat tujuan. Pemulihan bungkus memeriksa autentikasi, ID checkpoint, isi manifest, ukuran dan hash sebelum memublikasikan direktori hasil. Ini **tidak** menjalankan SQL atau mengekstrak tar volume; plaintext sementara harus berada di ruang privat. Simpan private key sumber dan tujuan terpisah dari bundle dan satu sama lain. Simpan material Relay melalui jalur pemulihan rahasia terpisah, bukan di artefak.

Tes `bash scripts/test-relay-offhost-bundle.sh` memakai input sintetis 16 MiB: byte cocok; perubahan ciphertext, ID checkpoint salah, dan signer yang tidak tepercaya ditolak. Ini hanya memverifikasi kemasan, bukan kehilangan host. Latihan end-to-end memerlukan tujuan staging yang benar-benar terpisah dan transport penyimpanan off-host yang disetujui. Di tujuan, tahan akses ke host sumber, impor SQL ke database kosong, pulihkan volume ke Wings baru yang terisolasi, lalu ukur waktu hingga workload membaca byte checkpoint dan selisih perubahan pasca-checkpoint. Jangan menetapkan RTO/RPO atau melanjutkan pilot produksi dari tes kemasan ini.
[CI 45635601494](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45635601494): kedua job lulus. Runner pemulihan memvalidasi paket terenkripsi, menolak salinan rusak, mengimpor fixture ke MySQL baru, dan mencocokkan pemilik, alokasi, serta SHA-256 dari container tanpa jaringan. Fixture 128 MiB dipulihkan dalam **3.097 ms** dari pembukaan paket valid hingga verifikasi, tidak termasuk download artefak atau startup MySQL. Ini bukan RTO Relay: database, volume, dan container yang dipakai masih sintetis; pemeriksaan Relay/Wings asli, izin API, dan perubahan yang hilang setelah checkpoint belum dilakukan lintas host.

## Recovery lintas runner — Relay dan Wings sungguhan

[Workflow manual 45637633661](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45637633661) lulus pada kedua runner GitHub-hosted. Runner sumber mengambil dump MySQL dan tar satu fixture Wings saat offline, lalu mengganti isi file dan mencabut grant kolaborator; API sumber mengembalikan 404 setelah pencabutan. Runner tujuan mengambil artefak terenkripsi, menolak salinan yang sengaja dirusak sebelum impor, lalu memulihkan ke MySQL kosong dan daemon Wings v1.13.5 baru. Tidak ada koneksi kembali ke runner sumber. Sertifikat penanda tangan diperiksa terhadap digest dari job sumber. Material runtime disposable dikirim dalam amplop CMS tersendiri yang juga ditandatangani dan dienkripsi untuk penerima yang sama; kunci privat penerima berasal dari GitHub Actions Secrets, bukan dari artefak. Untuk operasional produksi, simpan material runtime di jalur rahasia tersendiri, bukan di artefak yang sama.

Di tujuan, UUID, pemilik, node dan alokasi cocok. Bearer pemilik dan sesi kolaborator hasil restore berhasil, sedangkan pihak luar tetap mendapat 404. Pencabutan grant pasca-checkpoint tidak terbawa, jadi perlu diterapkan ulang. File pasca-checkpoint tidak terbawa: checksum file dibaca dari dalam container yang aktif dan mount diverifikasi mengarah ke volume staging baru.

Waktu pemulihan teramati **11.061 ms** dari pembukaan paket valid hingga verifikasi pembacaan dari dalam workload; tidak termasuk antrean, startup MySQL, download artefak, atau pengujian paket rusak. Fixture nyata ini kecil (arsip dibatasi 1 MiB); sebelumnya hanya fixture sintetis yang diuji pada 128 MiB. Ini bukan RTO/RPO produksi. Lanjutkan staging dengan workload lebih representatif dan jalur pemulihan kunci independen; jangan jadikan hasil ini sebagai izin cutover produksi.
