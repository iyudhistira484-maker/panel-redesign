# Tahap 4 — integrasi antarmuka dengan backend staging

Dimulai setelah pengguna menyetujui lanjut dari [bukti Tahap 3](../stage-3/review.md). Tiga sasaran staging ditutup; paritas produksi tetap mengikuti [gate pengganti Panel](../stage-3/replacement-gate.md).

Irisan pertama: formulir lupa/atur ulang kata sandi dwibahasa terhubung ke API staging. Tautan email memakai fragmen; UI membuang token dari URL sesudah dibaca, tidak menyimpannya ke storage, dan mengirimnya hanya ke API same-origin. Login dan dashboard contoh belum dipindah ke data nyata.

Untuk staging lokal, siapkan backend di port 3200 mengikuti [Tahap 2](../stage-2/README.md), jalankan `RELAY_DEV_API_PROXY=1 npm run dev`, dan buka UI lewat reverse proxy HTTPS lokal atau URL preview HTTPS. Set `RELAY_ORIGIN` ke origin HTTPS yang persis sama dengan URL browser (tanpa path atau trailing slash). Akses HTTP langsung tidak lolos persyaratan API staging. Proxy tidak mengubah header Origin atau mematikan CSRF. Tes browser mencegat request untuk menguji kontrak UI; verifikasi browser langsung dengan SMTP staging masih terpisah.

[CI 45508416790](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45508416790): job `verify` (termasuk Playwright recovery) lulus; keseluruhan run tidak hijau karena `mumble-missing-report` mengalami kembali checksum arsip Wings tidak cocok. Ini masalah transfer yang sudah tercatat di Tahap 3 dan tetap terbuka, bukan kelulusan ulang seluruh matriks.

## Login, verifikasi dua langkah, dan sesi

Halaman masuk memakai endpoint `login`, `challenge`, `logout`, dan `GET /api/v1/account`. UI tidak menganggap tantangan 2FA sebagai login selesai: sesi harus dikonfirmasi oleh endpoint akun sebelum nama ditampilkan. Reload membaca sesi dari backend dan logout meminta backend mencabutnya. Password dan kode tidak disimpan di browser storage; cakupan ini belum menghubungkan dashboard atau enrollment 2FA. Tes browser memakai intersepsi API, sedangkan pengujian MySQL backend tetap terpisah.

## Uji browser langsung tanpa mock

[CI 45526792661](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45526792661) lulus semua 13 job. Job `identity` menjalankan Playwright terhadap frontend terbangun, proxy HTTPS loopback dengan sertifikat CI, proses API asli, MySQL, dan Mailpit. Akun uji disemai dengan 2FA; browser meminta reset, membuka email, mengatur password, menguji replay tautan di tab yang sama, login, membuktikan sesi belum otoritatif sebelum 2FA, memverifikasi cookie Secure/HttpOnly, lalu reload dan logout. Cookie sebelum logout kembali ditolak sesudah logout. Tidak ada mock request browser pada latihan ini. Enrolment 2FA di UI dan katalog baca-saja belum tercakup.
