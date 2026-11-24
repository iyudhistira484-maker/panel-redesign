# Tahap 4 — integrasi antarmuka dengan backend staging

Dimulai setelah pengguna menyetujui lanjut dari [bukti Tahap 3](../stage-3/review.md). Tiga sasaran staging ditutup; paritas produksi tetap mengikuti [gate pengganti Panel](../stage-3/replacement-gate.md).

Irisan pertama: formulir lupa/atur ulang kata sandi dwibahasa terhubung ke API staging. Tautan email memakai fragmen; UI membuang token dari URL sesudah dibaca, tidak menyimpannya ke storage, dan mengirimnya hanya ke API same-origin. Login dan dashboard contoh belum dipindah ke data nyata.

Untuk staging lokal, siapkan backend di port 3200 mengikuti [Tahap 2](../stage-2/README.md), gunakan `RELAY_ORIGIN=http://127.0.0.1:5173` untuk metode HTTP lokal, lalu jalankan `RELAY_DEV_API_PROXY=1 npm run dev`. Akses dari origin yang sama; untuk preview HTTPS gunakan origin browser persis. Proxy tidak mengubah header Origin atau mematikan CSRF. Tes browser mencegat request untuk menguji kontrak UI; verifikasi browser langsung dengan SMTP staging masih terpisah.
