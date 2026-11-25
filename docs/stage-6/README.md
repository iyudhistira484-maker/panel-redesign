# Tahap 6 — pengelolaan subuser staging

Irisan awal: **Detail server → Kelola akses aktivitas**. Pemilik dapat memberi/mencabut `activity.read` untuk akun yang sudah ada dengan memasukkan email. Mutasi memerlukan sesi browser, pemeriksaan origin, dan kepemilikan di transaksi DB. Grant yang sudah ada tidak ditimpa; pencabutan hanya menghapus grant yang persis berisi `activity.read`. Perubahan dicatat dalam audit server.

[CI 45539999094](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45539999094) lulus 14 job. Browser HTTPS dan Wings sungguhan membuktikan pemberian/pencabutan dari UI, penolakan mutasi serta Start/Stop bagi subuser, dan HTTP 404 untuk riwayat setelah pencabutan meski sesi akun masih aktif. Data yang telah dibaca sebelum pencabutan tidak bisa ditarik kembali. Undangan, daftar subuser, dan pengelolaan izin lain belum tercakup. Tidak ada deployment produksi.

## Daftar subuser dan pencabutan terkonfirmasi

**Muat daftar subuser** menampilkan email akun dan izin aktif (maksimal 100, dengan indikator jika terpotong). Endpoint hanya tersedia bagi pemilik. Tombol pencabutan dari daftar memerlukan konfirmasi dan hanya muncul untuk grant persis `activity.read`; grant gabungan ditampilkan tanpa tombol pengubahan. Daftar diperbarui setelah mutasi tanpa reload halaman.

[CI 45540568501](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45540568501) lulus 14 job. Chromium/HTTPS membuktikan daftar khusus pemilik, penolakan HTTP 404 untuk subuser, izin tetap aktif sebelum konfirmasi, pembaruan daftar setelah konfirmasi, grant gabungan tetap ada, dan penolakan akses setelah pencabutan meski sesi subuser masih aktif.

## Izin Start dan Stop terpisah

Pemilik dapat memberi/cabut `control.start` dan `control.stop` secara independen dari baris subuser aktif, dengan konfirmasi. Mutasi memerlukan kepemilikan dan sesi browser; transaksi mengubah satu izin dan mempertahankan izin lain. Audit mencatat pemberian/pencabutan. Akun belum terdaftar sebagai subuser harus diberi akses awal terlebih dahulu.

[CI 45541752889](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45541752889) lulus 14 job. Pemilik memberi Start dari UI; subuser memakai sesi HTTPS untuk menyalakan workload Wings sungguhan dan ditolak untuk Stop. Setelah Start dicabut dari UI, sesi yang sama langsung ditolak untuk Start tetapi masih dapat membaca aktivitas. Audit grant/revoke terlihat. Tes ini tidak mengklaim skenario Stop-only end-to-end.

### Bukti Stop-only

[CI 45542374771](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45542374771) lulus seluruh 14 job. Pemilik memberi Stop dari UI pada workload yang berjalan. Dengan sesi yang sama, subuser menghentikan workload sampai Wings benar-benar `offline`, tetapi ditolak saat meminta Start. Setelah pemilik mencabut Stop, permintaan Stop langsung mendapat 404 meski akun masih login dan tetap punya `activity.read`. Pemberian dan pencabutan Stop terlihat di riwayat audit.

## Isolasi izin antarserver dan penutupan cakupan staging

[CI 45543074170](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45543074170) lulus 14 job. Kontrak `legacy-panel` menggunakan satu sesi subuser, dua workload, dua node Wings sungguhan, dan dua binding API Relay. Pemilik memberi Start di A dan Stop di B melalui API; aksi kebalikan ditolak di masing-masing server. Setelah Start di A dicabut, sesi yang sama ditolak untuk Start di A tetapi berhasil menghentikan B sampai `offline`, sementara A tetap `running`. Tes lintas server adalah pengujian API dan Wings; pengujian UI grant/revoke tetap dijalankan dalam job yang sama.

Cakupan Tahap 6 yang disepakati untuk akun yang sudah ada selesai di staging. Undangan email, pengelolaan izin umum, dan cutover produksi tidak termasuk.
