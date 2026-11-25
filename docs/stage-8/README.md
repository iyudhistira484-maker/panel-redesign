# Tahap 8 — kompatibilitas Client API Pterodactyl

Irisan staging baca-saja: `GET /api/client` (termasuk slash akhir) dan `GET /api/client/servers/:identifier`. Relay memakai kunci API Relay via Bearer, bukan sesi browser atau kunci legacy. Daftar/detail hanya berisi server milik akun atau yang dibagikan melalui grant aktif. Kunci tidak memperoleh hak admin. ID menggunakan UUID penuh atau awalan UUID delapan karakter; detail menolak awalan yang ambigu dalam cakupan akun. Pagination mendukung `page` dan `per_page` (maksimal 100 per halaman).

Bentuk `object`, `attributes`, `data`, dan pagination mengikuti bagian yang diuji. Atribut baru mencakup UUID, identifier pendek default, nama, node, dan kepemilikan. Ini bukan kontrak atribut lengkap Pterodactyl: identifier alternatif, ID numerik lama, limits, alokasi/relationships, filter dan route tulis di luar cakupan yang dijelaskan di bawah belum didukung. Application API belum tercakup.

[CI 45552934168](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45552934168) lulus 14 job. SDK Nodeactyl 3.3.0 yang tidak dimodifikasi menjalankan fungsi daftar, detail, dan halaman berikutnya yang sama terhadap Panel v1.15.2 asli dan Relay; URL dan kunci saja yang berbeda antarpanel pada probe. Axios dipin melalui override dev untuk menghindari dependency lama. Kontrak juga membandingkan angka pagination dan memeriksa penolakan bagi sesi tanpa Bearer serta akses di luar grant. Ini bukti SDK baca-saja, bukan klaim migrasi semua integrasi pihak ketiga atau deployment produksi.

## Statistik resource melalui Client API

`GET /api/client/servers/:identifier/resources` mengembalikan `object: stats`, status server, dan metrik dari satu pembacaan REST Wings, tanpa meneruskan konfigurasi Wings. Satuan mengikuti Wings/Panel: memori, disk, jaringan dalam byte; CPU persentase absolut; uptime milidetik. Endpoint hanya dapat membaca workload staging terpasang dengan binding Wings yang dikenal dan kunci yang berhak atas server. Relay mengembalikan 502 saat Wings tidak tersedia atau payload tidak valid, bukan statistik nol pengganti; 503 berarti workload tidak tersedia pada binding staging ini.

[CI 45553573042](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45553573042) lulus 14 job. `getServerUsages` Nodeactyl yang sama membandingkan struktur, nama metrik, dan tipe terhadap Panel v1.15.2 asli dan Relay; angka dinamis tidak dituntut sama. Tes membuktikan grant yang sah, penolakan akun lain/sesi saja, serta 502 tanpa atribut statistik saat daemon dipause dan pemulihan setelah unpause. Kontrak ini bukan kompatibilitas seluruh error Pterodactyl.

## Filter daftar server

`GET /api/client` mendukung `filter[name]`, `filter[uuid]` (pencocokan substring tanpa membedakan kapital), dan `type=owner`. Filter dikombinasikan dengan AND dan hanya diterapkan pada cakupan akun. Query total dan data memakai syarat yang sama; tautan pagination mempertahankan filter. Wildcard SQL pada input nama diperlakukan sebagai karakter literal. Filter array/koma, tipe admin, dan filter lain belum didukung.

[CI 45554055846](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45554055846) lulus 14 job. Permintaan staging terhadap Panel v1.15.2 asli dan Relay membandingkan UUID hasil dan metadata pagination untuk nama, UUID, gabungan owner, serta hasil kosong. Dengan dua server bernama sama, kunci subuser Relay hanya mendapat server yang dibagikan dan total satu; pencarian UUID server lain atau pemilihan `type=owner` untuk subuser menghasilkan daftar kosong dan total nol.

## Start dan Stop melalui Client API

`POST /api/client/servers/:identifier/power` menerima `{"signal":"start"}` atau `{"signal":"stop"}` untuk fixture terpasang. Saat membuat kunci melalui endpoint akun staging, set `clientPower: true` untuk mengaktifkan kontrol secara eksplisit. Migrasi 012 memberi nilai default `false` untuk kunci lama dan baru tanpa opt-in. Di transaksi yang sama sebelum dispatch, Relay memeriksa kunci masih aktif serta kepemilikan atau izin aksi spesifik; kunci tidak mewarisi akses admin. Klien tanpa cookie dan Origin dapat memakai Bearer pada route ini; perlindungan origin browser tetap berlaku. HTTP 204 berarti dispatch diterima, bukan konfirmasi perubahan runtime. Restart, Kill, dan Application API belum didukung.

[CI 45568607791](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45568607791) lulus semua 14 job. Nodeactyl tanpa perubahan memanggil Start/Stop pada Panel v1.15.2 dan Relay, lalu tes membaca keadaan Wings `running`/`offline`. Kunci tanpa opt-in, sesi saja, Origin asing, serta aksi di luar grant ditolak. Saat grant Start dicabut, kunci subuser yang sama langsung ditolak untuk Start namun tetap dapat membaca statistik. Tidak ada perubahan di VPS atau produksi.
