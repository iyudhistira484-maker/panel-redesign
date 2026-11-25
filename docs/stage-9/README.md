# Tahap 9 — Application API: inventaris server baca-saja

`GET /api/application/servers` mengembalikan `list`, data `server`, dan metadata pagination (`page`, `per_page`, default 50, maksimum 100). Urutan tetap berdasarkan ID Application; tautan mempertahankan ukuran halaman. `GET /api/application/servers/:id` memakai ID numerik dari hasil daftar, bukan UUID atau prefix. Migrasi 019 mengalokasikan ID stabil dalam database Relay; ID numerik Pterodactyl lama tidak dibawa, jadi gunakan UUID untuk mencocokkan inventaris sebelum berpindah dan nomor Relay untuk detail.

Proyeksi terbatas pada `id`, `uuid`, `identifier`, `name`, `external_id`, `node`, `allocation`, dan `status` (`null` untuk terpasang, `draft` jika belum diprovisi, selain itu fase Relay). Record `deleted` tidak ditampilkan. API tidak mengembalikan environment, konfigurasi container, kredensial node, atau relationships. Filter selain UUID tidak tersedia; pembuatan fixture terbatas dijelaskan di bawah.

Admin yang sudah masuk dapat membuat kunci lewat `POST /api/v1/account/application-keys` dengan `label` dan `readServers: true`; token hanya dikembalikan saat dibuat. Kunci berlaku 30 hari, disimpan sebagai digest terpisah dari kunci Client, dan hanya berlaku selama penerbit masih admin. Penerbit dapat mencabutnya lewat `DELETE /api/v1/account/application-keys/:id`. Cookie sesi saja tidak mengautentikasi inventaris.

[CI 45597010598](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45597010598) lulus semua 14 job. Tes HTTP terhadap Panel v1.15.2 dan Relay mengambil dua halaman, mengecek metadata dan atribut yang didukung, dan memakai ID dari daftar masing-masing untuk detail. Tes juga memverifikasi penolakan kunci Client, kunci tanpa izin, sesi tanpa Bearer, kunci yang dicabut, dan kunci milik akun yang tidak lagi admin. Tidak ada perubahan di VPS atau produksi.

## UUID dan external ID

`GET /api/application/servers?filter[uuid]=…` menerima satu UUID lengkap atau substring (1–36 karakter heksadesimal/tanda hubung, tanpa membedakan kapital). Daftar dan total memakai filter yang sama; tautan mempertahankan filter dan `per_page`. `GET /api/application/servers/external/:external_id` melakukan pencocokan persis, peka kapital, dan mengembalikan `404` jika tidak ditemukan. URL-encode nilai sebagai satu segmen; ID harus sepanjang 1–191 karakter, tanpa slash, backslash, karakter kontrol, spasi di awal/akhir, atau segmen `.`/`..`. Keduanya memerlukan `readServers`.

Snapshot SQL membaca `servers.external_id` dengan izin SELECT kolom tersebut; impor fixture menyimpan nilai asli atau `null` dan menolak nilai tak valid/duplikat. Manifest lama tanpa kolom tersebut tetap dibaca sebagai `null`; migrasi 020 tidak menebak atau mengisi ID untuk server yang sudah diimpor sebelumnya.

[CI 45597989958](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45597989958) lulus 14 job. Tes membuktikan ID fixture asli dari Panel v1.15.2 dipertahankan setelah snapshot dan impor, lookup mengarah ke UUID yang sama, ID asing mengembalikan `404`, serta filter berhalaman/hasil kosong cocok pada kedua panel. Tes mengikuti tautan Relay dan memastikan filter tetap berlaku serta kunci Client atau Application tanpa izin tidak dapat memakai lookup.

## Inventaris node dan alokasi

`GET /api/application/nodes` dan `GET /api/application/nodes/:node` memerlukan `readNodes: true`; respons node hanya berisi `id`, `uuid`, dan `name`. `GET /api/application/nodes/:node/allocations` memerlukan `readAllocations: true` secara independen. Alokasi berisi `id`, `ip`, `port`, `assigned`, serta `alias` dan `notes` bernilai null karena Relay belum menyimpan kedua metadata itu. `assigned` mencakup alokasi utama dan sekunder. Daftar dan total alokasi dibatasi pada node yang diminta. Daftar menerima `page` dan `per_page` (default 50, maksimum 100).

Sejak migrasi 021, atribut `node` dan `allocation` pada inventaris server adalah ID numerik node dan alokasi utama di Relay. ID stabil dalam database Relay, bukan nomor lama Panel. Kunci `readServers` dapat melihat referensi tersebut, tetapi tidak otomatis mendapat detail node atau daftar alokasi. Tidak ada konfigurasi, alamat internal Wings, token, atau relationships pada respons node. Operasi tulis node dan alokasi tidak tersedia.

[CI 45606474954](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45606474954) lulus 14 job. Tes Panel v1.15.2 dan Relay mengikuti referensi server menuju node dan alokasi utama, membandingkan dua halaman per node, membuktikan alokasi node lain tidak masuk hasil ataupun total, dan membandingkan status alokasi utama, sekunder, serta kosong. Tes juga memeriksa izin terpisah dan memastikan proyeksi node tidak memuat kredensial.

## Buat satu server fixture

`POST /api/application/servers` memerlukan kunci Application dengan `createServers: true`, terpisah dari izin baca. Gunakan ID numerik Relay untuk `user`, `egg` dan `allocation.default`; saat ini ID pemilik/egg dipetakan oleh operator staging, bukan endpoint inventaris baru. Pemilik harus akun non-admin `@example.test` yang sudah ada. Alokasi loopback kosong harus dipilih eksplisit dan berada pada node Wings yang dilayani instance. Hanya egg shell disposable dengan profil tetap diterima: image `~relay-wings-contract-workload:ci`, startup `sh /home/container/relay-start.sh`, environment kosong, memory 128/swap 0/disk 64/io 500/cpu 50, feature limits semua 0 dan `start_on_completion` false. Boleh mengirim `external_id` yang valid.

Relay mengunci alokasi dan mencatat server serta dispatch dalam satu transaksi sebelum menghubungi Wings. HTTP 201 berarti server dibuat, bukan instalasi selesai; baca detail hingga status `null` (terpasang). Konflik alokasi menghasilkan 409. Jika Wings tidak mengonfirmasi penerimaan, respons 502 menyertakan referensi server berstatus `uncertain`; alokasi tetap dicadangkan dan Relay tidak mengirim ulang otomatis. Callback Wings yang sah masih bisa menyelesaikan instalasi setelah timeout. Edit, deploy otomatis, dan pembuatan massal tidak didukung; hapus fixture terbatas dijelaskan di bawah.

[CI 45610636513](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45610636513) lulus 14 job. Tes membuat fixture melalui HTTP di Panel v1.15.2 dan Relay, mengecek node/alokasi dan membaca artefak instalasi dari Wings. Dua permintaan bersamaan pada satu alokasi Relay menghasilkan satu 201 dan satu 409. Tes juga menolak kunci baca dan profil di luar allowlist, serta menjeda Wings untuk membuktikan status `uncertain`, alokasi tetap dicadangkan, dan hanya satu dispatch tercatat.

## Rekonsiliasi instalasi yang belum pasti

`POST /api/application/servers/:id/reconcile` adalah ekstensi Relay tanpa badan permintaan. Gunakan ID numerik Relay dan kunci Application dengan `reconcileServers: true`; `createServers` dan `readServers` tidak otomatis memberikan akses. Hanya fixture hasil pembuatan Application yang dapat diperiksa. Migrasi 023 menandai fixture Application lama berdasarkan audit dispatch yang sudah ada.

Respons `server_reconciliation` memisahkan fase tersimpan (`uncertain`, `installing`, `installed`, `install_failed`) dari pengamatan Wings (`present`, `absent`, `unreachable`) beserta state runtime jika tersedia. Hanya callback instalasi terautentikasi yang menyelesaikan fase; pengamatan tidak mengganti fase, mengirim ulang create, atau melepas alokasi. `uncertain` + `absent` bukan bukti bahwa instalasi gagal atau alokasi boleh dipakai kembali.

[CI 45612635189](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45612635189) lulus 14 job. Harness menahan dua permintaan create asli: satu tidak pernah dikirim ke Wings, satu dikirim sekali setelah Relay sudah melaporkan `uncertain`. Rekonsiliasi pertama tetap `uncertain`/`absent` dengan alokasi terpesan. Pada kasus kedua, callback dari Wings sungguhan menandai `installed`, dan artefak instalasi dibaca balik. Keduanya mencatat hanya satu dispatch per server; kunci tanpa izin dan server adopsi ditolak.

## Hapus satu server fixture offline

`DELETE /api/application/servers/:id` memerlukan kunci Application `deleteServers: true` dan ID numerik Relay. Tanpa badan maupun query. Hanya shell fixture hasil Application API yang terbukti `installed` dan `offline`, tanpa alokasi sekunder atau riwayat transfer. Server adopsi, server yang instalasinya belum pasti, force delete, dan hapus massal tidak diizinkan.

Relay mencatat fase `deleting` sebelum dispatch. HTTP 204 hanya diberikan setelah Wings menerima penghapusan, pembacaan Wings mengonfirmasi server tidak ada, dan transaksi membersihkan inventaris serta melepaskan alokasi. Audit penghapusan tetap tersimpan. Jika dispatch atau verifikasi tidak terkonfirmasi, respons 502 dengan `delete_uncertain` mempertahankan record dan alokasi; percobaan ulang ditolak. Jika pemeriksaan awal tidak dapat mengonfirmasi offline, Relay tidak mengirim perintah hapus. Cakupan satu instance fixture, bukan jaminan terhadap tindakan administrator eksternal di Wings.

[CI 45613937502](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45613937502) lulus 14 job. Tes memverifikasi target hilang dari Wings dan inventaris, kontrol tetangga tetap utuh, dan alokasi dapat dipakai untuk instalasi baru dengan UUID/ID baru. Pada kegagalan transport DELETE yang diinjeksi, tes membuktikan status `delete_uncertain`, alokasi tidak bisa digunakan ulang, dan hanya satu dispatch tercatat.
