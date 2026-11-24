# Tahap 4 — integrasi antarmuka dengan backend staging

Dimulai setelah pengguna menyetujui lanjut dari [bukti Tahap 3](../stage-3/review.md). Tiga sasaran staging ditutup; paritas produksi tetap mengikuti [gate pengganti Panel](../stage-3/replacement-gate.md).

Irisan pertama: formulir lupa/atur ulang kata sandi dwibahasa terhubung ke API staging. Tautan email memakai fragmen; UI membuang token dari URL sesudah dibaca, tidak menyimpannya ke storage, dan mengirimnya hanya ke API same-origin. Login dan dashboard contoh belum dipindah ke data nyata.

Untuk staging lokal, siapkan backend di port 3200 mengikuti [Tahap 2](../stage-2/README.md), jalankan `RELAY_DEV_API_PROXY=1 npm run dev`, dan buka UI lewat reverse proxy HTTPS lokal atau URL preview HTTPS. Set `RELAY_ORIGIN` ke origin HTTPS yang persis sama dengan URL browser (tanpa path atau trailing slash). Akses HTTP langsung tidak lolos persyaratan API staging. Proxy tidak mengubah header Origin atau mematikan CSRF. Tes browser mencegat request untuk menguji kontrak UI; verifikasi browser langsung dengan SMTP staging masih terpisah.
