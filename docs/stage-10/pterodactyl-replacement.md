# Keputusan penggantian Pterodactyl

Target: Relay mengambil alih fungsi Panel Pterodactyl; Wings tetap menjalankan workload. **Belum siap cutover produksi atau diklaim setara penuh.** Bukti staging tidak otomatis berlaku pada workload produksi, terutama untuk penulisan aktif, operasi destruktif, dan integrasi eksternal.

| Area | Bukti yang tersedia | Syarat sebelum dinyatakan setara |
| --- | --- | --- |
| Akun dan operasi harian | Login, reset, TOTP, inventaris, power, statistik, console dan sebagian file diuji di staging | Jalankan skenario harian kandidat; verifikasi SFTP (password dan key), operasi file yang belum terbukti, dan izin lintas pengguna |
| Siklus hidup dan integrasi | Application API untuk inventaris, create/delete dan rekonsiliasi fixture; Nodeactyl untuk cakupan Client yang diuji | Uji integrasi yang benar-benar dipakai, startup/image/reinstall, secondary allocation, dan egg representatif. Jangan perluas operasi destruktif sampai batas cakupannya diverifikasi |
| Penyimpanan dan otomatisasi | Restore database panel dan volume Wings lintas runner; rollback ke Pterodactyl untuk server adopsi | Uji backup per-server lokal/S3, database milik workload, jadwal, subuser, retensi, dan pemulihan kunci produksi bila fitur itu dipakai |
| Cutover dan rollback | Fixture adopsi kembali terlihat di Pterodactyl; fixture buatan Relay tidak otomatis muncul di sana | Inventaris kedua panel harus direkonsiliasi; tetapkan satu panel yang boleh menulis, batas keputusan rollback, dan tindakan eksplisit untuk entitas baru serta perubahan pasca-checkpoint |

## Urutan kerja

1. **Lulus di staging:** [uji HTTP lintas runner](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45657665682) membuktikan baca checkpoint, tulis, dan baca ulang setelah restart dari client lain di jaringan staging. Bukti terbatas pada fixture HTTP sintetis.
2. Pilih satu workload staging representatif dan buat daftar fitur yang digunakan berdasarkan [inventaris Client](../stage-0/api-client.md), [Application](../stage-0/api-application.md), dan [checklist upstream](../stage-0/parity.md). Tandai tiap fitur **terbukti**, **belum diuji**, **belum tersedia**, atau **tidak digunakan**. Jangan menandai kemampuan Relay hanya karena endpoint upstream tercatat.
3. Uji migrasi dan rollback workload itu sebelum menjadwalkan produksi. Catat batas downtime/kehilangan data, langkah penerapan ulang pencabutan akses, penanggung jawab, dan mekanisme observasi layanan. Jalankan backup/restore dan rollback sebagai latihan operasi, bukan sekadar proses CI hijau.
4. Jika semua fitur yang diperlukan lulus dan pemilik menyetujui, pilot produksi satu server berisiko rendah; Pterodactyl tetap tersedia untuk rollback. Perlu persetujuan eksplisit sebelum rollout. Migrasi bertahap setelah pilot stabil. Untuk mengklaim **setara penuh**, tuntaskan pula fitur upstream di luar cakupan pilot atau dokumentasikan pengecualiannya.
