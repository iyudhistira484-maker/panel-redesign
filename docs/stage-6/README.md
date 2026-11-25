# Tahap 6 — pengelolaan subuser staging

Irisan awal: **Detail server → Kelola akses aktivitas**. Pemilik dapat memberi/mencabut `activity.read` untuk akun yang sudah ada dengan memasukkan email. Mutasi memerlukan sesi browser, pemeriksaan origin, dan kepemilikan di transaksi DB. Grant yang sudah ada tidak ditimpa; pencabutan hanya menghapus grant yang persis berisi `activity.read`. Perubahan dicatat dalam audit server.

[CI 45539999094](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45539999094) lulus 14 job. Browser HTTPS dan Wings sungguhan membuktikan pemberian/pencabutan dari UI, penolakan mutasi serta Start/Stop bagi subuser, dan HTTP 404 untuk riwayat setelah pencabutan meski sesi akun masih aktif. Data yang telah dibaca sebelum pencabutan tidak bisa ditarik kembali. Undangan, daftar subuser, dan pengelolaan izin lain belum tercakup. Tidak ada deployment produksi.

## Daftar subuser dan pencabutan terkonfirmasi

**Muat daftar subuser** menampilkan email akun dan izin aktif (maksimal 100, dengan indikator jika terpotong). Endpoint hanya tersedia bagi pemilik. Tombol pencabutan dari daftar memerlukan konfirmasi dan hanya muncul untuk grant persis `activity.read`; grant gabungan ditampilkan tanpa tombol pengubahan. Daftar diperbarui setelah mutasi tanpa reload halaman.

[CI 45540568501](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45540568501) lulus 14 job. Chromium/HTTPS membuktikan daftar khusus pemilik, penolakan HTTP 404 untuk subuser, izin tetap aktif sebelum konfirmasi, pembaruan daftar setelah konfirmasi, grant gabungan tetap ada, dan penolakan akses setelah pencabutan meski sesi subuser masih aktif.
