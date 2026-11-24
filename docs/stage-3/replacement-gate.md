# Target Relay: pengganti Pterodactyl Panel

Keputusan pengguna, 24 November 2026: Relay mengejar **paritas fitur Pterodactyl Panel**, bukan rilis yang hanya mendukung instalasi baru. Relay menggantikan panel, bukan Wings. Pengguna yang mulai dari nol tidak perlu memasang Panel lama; pengguna yang bermigrasi harus dapat membawa data dan memakai Wings yang sudah ada. Perbaikan desain tidak menjadi alasan menghapus fitur baseline.

## Bukti yang diperlukan untuk menutup Tahap 3

| Area | Sudah terbukti di staging | Belum memenuhi target pengganti |
| --- | --- | --- |
| Adopsi Wings | Dua node dari Panel v1.15.2 dialihkan ke Relay dan kembali tanpa membuat ulang workload; UUID dan checksum fixture tetap sama. | Rehearsal umum dengan salinan katalog yang merepresentasikan variasi data dan konfigurasi node. |
| Impor | Preflight relasi dan izin; transaksi dua server uji, replay idempoten, rollback konflik. | Jalur baca dari salinan database Panel, pemetaan dan pemeriksaan akun, relasi, izin, serta data terenkripsi. Dry-run harus tanpa tulis. Apply hanya ke staging, disertai laporan hasil tanpa rahasia. |
| Eksekusi egg | PTDL v1/v2 diimpor dan dijalankan pada Wings dengan variabel startup serta satu rewrite JSON. | Kualifikasi egg representatif di luar daftar byte fixture, dengan validasi variabel, image, startup, konfigurasi dan isolasi eksekusi. Egg yang belum didukung harus ditolak dengan alasan yang jelas. |
| Transfer | Dispatch, callback, finalisasi dan status ambigu di dua Wings; skenario sukses serta pemulihan memakai proses Relay terpisah. | Transfer workload yang tidak bergantung pada fixture tunggal, dan rekonsiliasi yang aman untuk hasil ambigu. Tidak ada penghapusan sumber berdasarkan timeout atau callback saja. |

Bukti per skenario dan cara mengulangnya tercatat di [laporan Tahap 3](README.md). Tahap 3 belum ditutup. Tahap 4 harus disetujui terpisah. Gate ini tidak menggantikan [daftar paritas menyeluruh](../stage-0/parity.md): lulus Tahap 3 tidak berarti Relay sudah siap menggantikan Panel produksi.

## Apa arti “lebih modern”

Gunakan satu antarmuka admin dan pengguna dengan navigasi konsisten, status tindakan yang jelas, aksesibilitas, serta bahasa Indonesia dan Inggris. Tampilkan operasi yang gagal atau hasilnya belum pasti tanpa menyembunyikan batasan Wings. Pertahankan alur lama yang masih dibutuhkan; ukur kompatibilitas integrasi dengan kontrak API dan tes, bukan dengan kemiripan tampilan.

Selama pengembangan, tidak diperlukan Panel lama, backup, atau kredensial milik pengguna. Rehearsal dengan salinan produksi dan cutover mengikuti tahap dan persetujuan terpisah; sistem produksi tetap tidak disentuh.
