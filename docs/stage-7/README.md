# Tahap 7 — file server staging

Irisan awal **Detail server → Buka daftar file**: pemilik fixture Wings terpasang dapat melihat nama, tipe folder/file, dan ukuran file; dapat membuka folder serta kembali ke induknya. Tidak ada pembacaan isi file, unduh, unggah, edit, atau hapus. Backend memeriksa sesi dan kepemilikan; izin aktivitas dan power tidak memberi akses file. Listing dibatasi 100 entri, 128 KiB per respons Wings, empat segmen nama yang divalidasi, dan hanya file reguler/folder. Relay tidak menampilkan symlink atau memakainya sebagai segmen; isolasi filesystem tetap bergantung pada Wings, bukan klaim keamanan terhadap semua perubahan file concurrent.

[CI 45544257538](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45544257538) lulus semua 14 job. Chromium/HTTPS dengan Wings sungguhan membuka root dan fixture-docs, melihat example.txt dan kembali ke induk. Permintaan sesi subuser serta navigasi symlink mendapat 404; path dengan `..` mendapat 400. Tidak ada deployment VPS atau produksi.

## Pratinjau teks

Pemilik bisa membuka file `.txt` reguler hingga 16 KiB dari daftar file. Relay memverifikasi folder dan entri di Wings, membatasi pembacaan aktual, menolak UTF-8 tidak valid dan karakter kontrol biner, lalu mengirim JSON tanpa cache. Browser menampilkan teks literal, bukan HTML. Mengganti file atau folder membersihkan pratinjau lama; berpindah server melepas komponen detail. Tidak ada endpoint unduh, edit, unggah, atau hapus dalam irisan ini.

[CI 45544964048](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45544964048) lulus semua 14 job. Chromium/HTTPS dengan Wings sungguhan membuktikan markup tampil literal dan pembacaan file biner membersihkan pratinjau sebelumnya. Permintaan subuser, symlink, traversal, serta file terlalu besar ditolak. Isolasi filesystem tetap bergantung pada Wings; ini bukan klaim terhadap semua perubahan filesystem serentak.

## Unduhan lampiran teks

**Unduh file teks** mengambil byte asli file `.txt` yang sudah lolos validasi pratinjau (maksimal 16 KiB). API mengirim lampiran `application/octet-stream` dengan `nosniff` dan `no-store`; tidak melakukan konversi encoding. Tidak ada penambahan akses tulis.

[CI 45548625075](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45548625075) lulus 14 job. Chromium membandingkan byte dari file tersimpan dengan fixture Wings, serta menolak subuser, symlink, traversal, dan file di atas batas. Uji API dua node Wings menggunakan `example.txt` dengan byte berbeda dan membuktikan masing-masing binding mengembalikan file yang benar (termasuk BOM dan CRLF pada server kedua), sementara binding salah menolak.

## Edit teks staging dengan pemeriksaan versi

**Edit teks staging** hanya untuk pemilik fixture terpasang dan offline, pada file yang sudah ada `/fixture-docs/example.txt`. Batas simpan 16 KiB UTF-8. Pratinjau mengembalikan versi SHA-256 byte asli; Relay membaca ulang versi sebelum mengirim tulis, menolak versi usang dengan 409, lalu memverifikasi byte dari Wings sebelum menampilkan sukses. UI meminta muat ulang setelah konflik atau hasil yang tidak terverifikasi. Tidak ada retry tulis otomatis.

Operasi memakai penguncian per-server selama request di satu proses Relay (termasuk dispatch power yang memakai penguncian sama), bukan compare-and-swap atomik di Wings. Penulis eksternal atau beberapa proses Relay masih bisa berlomba antara pembacaan dan penulisan, sehingga ini bukan editor umum atau jaminan konkurensi produksi.

[CI 45549312654](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45549312654) lulus 14 job. Chromium menyimpan ke Wings, membuka kembali isi yang berubah, membuktikan versi lama mendapat 409 tanpa menimpa hasil, dan subuser mendapat 404. Membuat file, unggah, dan hapus belum tercakup.

## Penutupan cakupan staging

[CI 45551306303](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45551306303) lulus 14 job. Chromium menyimpan perubahan di A, lalu Wings A dijeda sebelum percobaan simpan berikutnya. Relay tidak dapat memverifikasi status sebelum penulisan dan mengembalikan 502; UI tidak mengklaim sukses, memblokir simpan ulang, dan mengirim tepat satu POST. Setelah Wings dilanjutkan, muat ulang dari UI membaca versi terakhir yang berhasil. Setelah tes, pembacaan dari kedua node membuktikan file A berubah sesuai hasil Chromium dan file B dengan nama serta jalur identik tetap utuh byte demi byte.

Ini menutup cakupan daftar, pratinjau, unduhan, dan edit satu file fixture yang disepakati di staging. Kegagalan setelah write diterima tetapi sebelum read-back tidak diinjeksi secara langsung; editor umum, unggah, hapus, penulisan serentak lintas proses, dan cutover tidak tercakup.
