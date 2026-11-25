# Tahap 7 — file server staging

Irisan awal **Detail server → Buka daftar file**: pemilik fixture Wings terpasang dapat melihat nama, tipe folder/file, dan ukuran file; dapat membuka folder serta kembali ke induknya. Tidak ada pembacaan isi file, unduh, unggah, edit, atau hapus. Backend memeriksa sesi dan kepemilikan; izin aktivitas dan power tidak memberi akses file. Listing dibatasi 100 entri, 128 KiB per respons Wings, empat segmen nama yang divalidasi, dan hanya file reguler/folder. Relay tidak menampilkan symlink atau memakainya sebagai segmen; isolasi filesystem tetap bergantung pada Wings, bukan klaim keamanan terhadap semua perubahan file concurrent.

[CI 45544257538](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45544257538) lulus semua 14 job. Chromium/HTTPS dengan Wings sungguhan membuka root dan fixture-docs, melihat example.txt dan kembali ke induk. Permintaan sesi subuser serta navigasi symlink mendapat 404; path dengan `..` mendapat 400. Tidak ada deployment VPS atau produksi.

## Pratinjau teks

Pemilik bisa membuka file `.txt` reguler hingga 16 KiB dari daftar file. Relay memverifikasi folder dan entri di Wings, membatasi pembacaan aktual, menolak UTF-8 tidak valid dan karakter kontrol biner, lalu mengirim JSON tanpa cache. Browser menampilkan teks literal, bukan HTML. Mengganti file atau folder membersihkan pratinjau lama; berpindah server melepas komponen detail. Tidak ada endpoint unduh, edit, unggah, atau hapus dalam irisan ini.

[CI 45544964048](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45544964048) lulus semua 14 job. Chromium/HTTPS dengan Wings sungguhan membuktikan markup tampil literal dan pembacaan file biner membersihkan pratinjau sebelumnya. Permintaan subuser, symlink, traversal, serta file terlalu besar ditolak. Isolasi filesystem tetap bergantung pada Wings; ini bukan klaim terhadap semua perubahan filesystem serentak.
