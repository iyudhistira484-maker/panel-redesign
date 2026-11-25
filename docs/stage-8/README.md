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

`POST /api/client/servers/:identifier/power` menerima `{"signal":"start"}` atau `{"signal":"stop"}` untuk fixture terpasang. Saat membuat kunci melalui endpoint akun staging, set `clientPower: true` untuk mengaktifkan kontrol secara eksplisit. Migrasi 012 memberi nilai default `false` untuk kunci lama dan baru tanpa opt-in. Di transaksi yang sama sebelum dispatch, Relay memeriksa kunci masih aktif serta kepemilikan atau izin aksi spesifik; kunci tidak mewarisi akses admin. Klien tanpa cookie dan Origin dapat memakai Bearer pada route ini; perlindungan origin browser tetap berlaku. HTTP 204 berarti dispatch diterima, bukan konfirmasi perubahan runtime. Kill dan Application API belum didukung.

[CI 45568607791](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45568607791) lulus semua 14 job. Nodeactyl tanpa perubahan memanggil Start/Stop pada Panel v1.15.2 dan Relay, lalu tes membaca keadaan Wings `running`/`offline`. Kunci tanpa opt-in, sesi saja, Origin asing, serta aksi di luar grant ditolak. Saat grant Start dicabut, kunci subuser yang sama langsung ditolak untuk Start namun tetap dapat membaca statistik. Tidak ada perubahan di VPS atau produksi.

## Restart melalui Client API

Route power yang sama menerima `{"signal":"restart"}`. Kunci tetap memerlukan `clientPower: true`; subuser juga harus memiliki grant `control.restart`, terpisah dari `control.start` dan `control.stop`. Pemilik dapat mengelola grant ini lewat route akses server staging. Ketika Wings tidak dapat mengonfirmasi penerimaan, Relay mengembalikan HTTP 502 (`Power outcome unknown.`), mencatat hasil tidak pasti, dan tidak mengirim ulang. Timeout tidak membuktikan bahwa Wings membatalkan permintaan.

[CI 45570741227](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45570741227) lulus 14 job. Uji staging menggunakan Nodeactyl tanpa modifikasi pada Panel v1.15.2 dan Relay. Tes memeriksa identitas/waktu mulai container Docker berubah dan Wings kembali `running`, mengecek penolakan sebelum grant dan sesudah pencabutan, lalu menjeda Wings untuk menguji respons 502 dan audit. Kill tetap tidak didukung.

## Perintah konsol penanda di staging

`POST /api/client/servers/:identifier/command` menerima hanya `{"command":"relay-marker <24 digit heksadesimal huruf kecil>"}` untuk fixture shell disposable yang terpasang pada node staging. Fixture menangani penanda sebagai teks, bukan perintah shell. Kunci akun harus dibuat dengan `clientConsole: true` (default `false`, termasuk kunci lama); `clientPower` tidak memberi akses konsol dan sebaliknya. Subuser memerlukan grant `control.console`. Relay memeriksa ulang kunci dan grant sebelum mengirim ke Wings; audit tidak menyimpan teks perintah. HTTP 204 bukan bukti eksekusi, dan HTTP 502 berarti pengiriman tidak terkonfirmasi, tanpa pengiriman ulang otomatis.

[CI 45573119221](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45573119221) lulus semua 14 job. Nodeactyl tanpa modifikasi mengirim penanda ke Panel v1.15.2 dan Relay; tes melihat baris `RELAY_COMMAND_ACK` yang cocok di log runtime Wings/Docker. Relay menolak perintah bebas, newline tambahan, kunci khusus power, dan subuser sebelum grant maupun setelah grant dicabut dari kunci yang sama. Server offline mengembalikan 502. Perintah konsol bebas, streaming WebSocket kompatibilitas, Kill, dan Application API tetap di luar cakupan.

## Stream konsol WebSocket baca-saja di staging

`GET /api/client/servers/:identifier/websocket` mengembalikan `data.token` dan `data.socket`. Buat kunci dengan `clientStream: true` untuk mengaktifkannya; subuser juga memerlukan grant `websocket.connect`. Kunci biasa, power, dan command tidak memperoleh akses stream. Gateway Relay menerima frame `auth` dan mengirim `auth success` setelah autentikasi ke Wings. Gateway hanya meneruskan baris `RELAY_COMMAND_ACK <nonce>` langsung dari Wings; tidak menyediakan riwayat (`send logs` tidak mengambil data), output mentah, statistik WebSocket, atau input konsol/daya. Kredensial internal Wings tidak diserahkan ke klien.

Tiket Relay hanya berlaku untuk satu server dan satu koneksi, selama maksimal 15 detik sejak diterbitkan. Gateway memeriksa ulang kunci dan grant saat autentikasi dan setiap detik selama sesi. Tiket disimpan di proses Relay, sehingga irisan ini belum mendukung beberapa replika tanpa routing ke proses yang sama. URL `wss` berasal dari origin Relay terkonfigurasi; proxy staging harus meneruskan upgrade WebSocket pada `/api/client/streams/`.

[CI 45575764138](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45575764138) lulus 14 job. Uji live memakai bentuk respons dan frame autentikasi yang sama pada Panel v1.15.2 dan Relay, lalu membaca penanda unik langsung dari kedua WebSocket, tanpa log Docker. Tes juga membuktikan tiket tidak dapat dipakai ulang atau lintas server, input ditolak, sesi kedaluwarsa, dan pencabutan grant memutus sesi aktif dalam batas tes 3 detik serta menolak tiket lama dan penerbitan tiket baru.

## Daftar file dan unduhan melalui Client API

`GET /api/client/servers/:identifier/files/list?directory=/fixture-docs` mengembalikan `list` berisi `file_object`. Gunakan kunci dengan `clientListFiles: true`; subuser juga perlu grant `file.read`. `GET /api/client/servers/:identifier/files/download?file=/fixture-docs/binary.txt` mengembalikan `signed_url` dengan URL unduhan. Gunakan kunci dengan `clientDownload: true`; subuser juga perlu grant `file.read-content`. Keduanya opt-in terpisah dan default mati. Unduhan memeriksa lagi izin saat penukaran tiket dan sebelum mengembalikan byte. Tiket hanya berlaku untuk satu file dan server, sekali pakai, maksimal 15 detik, dan tersimpan pada proses Relay yang menerbitkannya.

Hanya fixture shell disposable yang terpasang: daftar maksimal 100 entri per direktori, kedalaman 4, tanpa symlink, dan unduhan file reguler maksimal 16 KiB. Upload dan hapus tidak didukung; edit teks terbatas dijelaskan di bawah.

[CI 45577144106](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45577144106) lulus 14 job. Nodeactyl 3.3.0 tidak mengekspos metode daftar/unduh file, sehingga tes memakai HTTP langsung dengan kontrak Client API yang sama pada Pterodactyl v1.15.2 dan Relay. Tes membandingkan nama, tipe dan ukuran entri non-symlink serta byte file biner, lalu memverifikasi batas izin, pencabutan, kedaluwarsa, replay, dan penukaran untuk nama file atau server lain.

## Baca dan edit teks bersyarat melalui Client API

`GET /api/client/servers/:identifier/files/contents?file=/fixture-docs/example.txt` menggunakan akses `clientDownload`/`file.read-content` dan mengembalikan byte `text/plain` dengan ETag SHA-256 kuat. `POST /api/client/servers/:identifier/files/write?file=/fixture-docs/example.txt` hanya untuk pemilik dengan kunci yang mengaktifkan `clientEditFile: true`, pada fixture shell terpasang dan offline. Kirim badan UTF-8 mentah (maksimal 16 KiB) dan ETag dari GET dalam `If-Match`. Relay mengembalikan 428 tanpa precondition valid, 412 jika versi sudah berubah, dan 204 setelah byte dibaca balik dari Wings. Pterodactyl tidak mewajibkan header tambahan ini; kompatibilitas tulis tidak penuh.

Editor API dan editor web menggunakan lock per server yang sama dalam satu proses Relay. Ini bukan operasi CAS di Wings: perubahan dari proses lain atau alat eksternal tidak dicakup oleh lock tersebut. Upload, penghapusan, dan edit path lain tetap tidak didukung.

[CI 45579635583](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45579635583) lulus 14 job setelah pengulangan job kualifikasi Forgejo. Job legacy Panel membandingkan baca/tulis HTTP pada Panel v1.15.2 dan Relay, membuktikan penolakan kunci khusus unduhan, UTF-8 invalid, file lain, dan ETag usang, serta mencocokkan BOM/CRLF dan byte UTF-8 setelah penulisan. Fixture dikembalikan ke byte awal sebelum kontrak browser.
