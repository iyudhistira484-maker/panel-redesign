# Tahap 6 — pengelolaan subuser staging

Irisan awal: **Detail server → Kelola akses aktivitas**. Pemilik dapat memberi/mencabut `activity.read` untuk akun yang sudah ada dengan memasukkan email. Mutasi memerlukan sesi browser, pemeriksaan origin, dan kepemilikan di transaksi DB. Grant yang sudah ada tidak ditimpa; pencabutan hanya menghapus grant yang persis berisi `activity.read`. Perubahan dicatat dalam audit server.

[CI 45539999094](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45539999094) lulus 14 job. Browser HTTPS dan Wings sungguhan membuktikan pemberian/pencabutan dari UI, penolakan mutasi serta Start/Stop bagi subuser, dan HTTP 404 untuk riwayat setelah pencabutan meski sesi akun masih aktif. Data yang telah dibaca sebelum pencabutan tidak bisa ditarik kembali. Undangan, daftar subuser, dan pengelolaan izin lain belum tercakup. Tidak ada deployment produksi.
