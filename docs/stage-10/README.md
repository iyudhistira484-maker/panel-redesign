# Tahap 10 — Latihan pemulihan dan rollback staging

[CI 45620443543](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45620443543), [job legacy Panel](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45620443543/job/139226836284), lulus 14 job. Harness membuat dump konsisten MySQL, menghentikan kedua instance Relay, lalu mengimpor ke schema kosong `relay_test_recovery` pada layanan MySQL CI yang sama. Instance Relay baru memakai schema hasil restore dan Wings yang sama. Dump dibatasi ke runner disposable, disimpan sementara dengan izin privat, tidak diunggah, dan dihapus setelah latihan.

| Pengukuran fixture CI | Durasi |
| --- | ---: |
| Membuat dump | 146 ms |
| Dari penghentian Relay hingga pemeriksaan pemulihan lulus | 1.647 ms |
| Switch kembali ke Panel lama dan rediscovery Wings | 1.133 ms |
| Dari checkpoint dump selesai hingga penghentian Relay | 793 ms |

Durasi ini hanya berlaku untuk fixture kecil dan lingkungan CI, bukan target RTO/RPO produksi. Perubahan nama dan pencabutan grant setelah dump tidak ikut pulih: grant yang dicabut kembali berlaku dari snapshot. Sebaliknya perubahan byte file setelah dump masih ada karena volume Wings tetap hidup dan tidak di-restore. Backup database ini bukan backup volume; kehilangan host database atau volume tidak diuji.

Pemulihan mencocokkan UUID, ID Application, external ID, pemilik, node, alokasi, fase instalasi, grant, sesi dan akses Bearer sebelum/sesudah. Dua workload adopsi mempertahankan identitas dan waktu mulai container, tanpa reinstall, serta checksum dan byte file. Saat Wings menunjuk kembali ke Panel v1.15.2, server adopsi tetap dapat ditemukan. Server yang dibuat di Relay tetap tercatat di Relay dan tidak muncul di inventaris Panel lama; ini bukan migrasi balik.

Material yang disimpan terpisah dari dump: `RELAY_TOTP_KEY` (material enkripsi TOTP), `RELAY_TOKEN_PEPPER` (digest sesi/token/kunci), `RELAY_NODE_KEY` (enkripsi kredensial node), pasangan token dan token ID Wings yang cocok, serta konfigurasi origin, koneksi database dan endpoint Wings. Harness memakai kembali material yang sama dan tidak menulis nilainya ke dokumentasi atau artefak. Pemulihan bila kunci hilang/dirotasi dan verifikasi backup volume tetap di luar cakupan. Tidak ada perubahan VPS atau produksi.
