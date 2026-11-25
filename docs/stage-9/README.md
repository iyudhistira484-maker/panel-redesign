# Tahap 9 — Application API: inventaris server baca-saja

`GET /api/application/servers` mengembalikan `list`, data `server`, dan metadata pagination (`page`, `per_page`, default 50, maksimum 100). Urutan tetap berdasarkan ID Application; tautan mempertahankan ukuran halaman. `GET /api/application/servers/:id` memakai ID numerik dari hasil daftar, bukan UUID atau prefix. Migrasi 019 mengalokasikan ID stabil dalam database Relay; ID numerik Pterodactyl lama tidak dibawa, jadi gunakan UUID untuk mencocokkan inventaris sebelum berpindah dan nomor Relay untuk detail.

Proyeksi terbatas pada `id`, `uuid`, `identifier`, `name`, `external_id`, dan `status` (`null` untuk terpasang, `draft` jika belum diprovisi, selain itu fase Relay). Record `deleted` tidak ditampilkan. API tidak mengembalikan environment, konfigurasi container, kredensial node, atau relationships. Filter selain UUID dan operasi tulis server tidak tersedia.

Admin yang sudah masuk dapat membuat kunci lewat `POST /api/v1/account/application-keys` dengan `label` dan `readServers: true`; token hanya dikembalikan saat dibuat. Kunci berlaku 30 hari, disimpan sebagai digest terpisah dari kunci Client, dan hanya berlaku selama penerbit masih admin. Penerbit dapat mencabutnya lewat `DELETE /api/v1/account/application-keys/:id`. Cookie sesi saja tidak mengautentikasi inventaris.

[CI 45597010598](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45597010598) lulus semua 14 job. Tes HTTP terhadap Panel v1.15.2 dan Relay mengambil dua halaman, mengecek metadata dan atribut yang didukung, dan memakai ID dari daftar masing-masing untuk detail. Tes juga memverifikasi penolakan kunci Client, kunci tanpa izin, sesi tanpa Bearer, kunci yang dicabut, dan kunci milik akun yang tidak lagi admin. Tidak ada perubahan di VPS atau produksi.

## UUID dan external ID

`GET /api/application/servers?filter[uuid]=…` menerima satu UUID lengkap atau substring (1–36 karakter heksadesimal/tanda hubung, tanpa membedakan kapital). Daftar dan total memakai filter yang sama; tautan mempertahankan filter dan `per_page`. `GET /api/application/servers/external/:external_id` melakukan pencocokan persis, peka kapital, dan mengembalikan `404` jika tidak ditemukan. URL-encode nilai sebagai satu segmen; ID harus sepanjang 1–191 karakter, tanpa slash, backslash, karakter kontrol, spasi di awal/akhir, atau segmen `.`/`..`. Keduanya memerlukan `readServers`.

Snapshot SQL membaca `servers.external_id` dengan izin SELECT kolom tersebut; impor fixture menyimpan nilai asli atau `null` dan menolak nilai tak valid/duplikat. Manifest lama tanpa kolom tersebut tetap dibaca sebagai `null`; migrasi 020 tidak menebak atau mengisi ID untuk server yang sudah diimpor sebelumnya.

[CI 45597989958](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45597989958) lulus 14 job. Tes membuktikan ID fixture asli dari Panel v1.15.2 dipertahankan setelah snapshot dan impor, lookup mengarah ke UUID yang sama, ID asing mengembalikan `404`, serta filter berhalaman/hasil kosong cocok pada kedua panel. Tes mengikuti tautan Relay dan memastikan filter tetap berlaku serta kunci Client atau Application tanpa izin tidak dapat memakai lookup.
