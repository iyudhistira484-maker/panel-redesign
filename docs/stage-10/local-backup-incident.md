# Backup lokal staging: callback Wings tidak tiba

Prosedur ini untuk fixture Wings staging, bukan instruksi operasi produksi. `202` hanya berarti permintaan diterima. Setelah dua menit tanpa callback, panel meminta pemeriksaan. Tidak ada retry otomatis untuk buat/restore.

1. Catat ID server, ID backup, node, operasi dan waktu kejadian. Pertahankan server offline dan hentikan jalur tulis lain selama pemeriksaan. Jangan sebarkan token node atau tautan unduhan.
2. Periksa log Wings dan Relay untuk ID dan waktu yang sama. Bedakan operasi arsip/restore dari kegagalan mengirim callback. Restart Wings atau Relay tidak membuktikan bahwa restore gagal atau callback akan dikirim ulang.
3. Untuk **buat backup**, bila arsip ada, verifikasi ukuran, integritas, dan isi terhadap checkpoint yang diketahui di salinan terisolasi. Arsip yang ada saja bukan bukti operasi tuntas. Untuk **restore**, amankan snapshot volume terkini dan bandingkan file yang diharapkan dengan checkpoint. Satu file cocok bukan bukti keseluruhan volume cocok; restore non-truncate juga mempertahankan file tambahan.
4. Jika callback sah tiba belakangan, baca status yang baru dan cocokkan dengan bukti. Jika tidak tiba, biarkan receipt tertunda; jangan mengirim callback palsu atau mengubah baris DB untuk memaksa status sukses. Untuk fixture yang boleh dibuang, simpan bukti lalu buat ulang fixture. Jangan mengulangi restore ke volume asli hanya untuk menghapus status pending.

Batas saat ini: prosedur ini mempertahankan bukti dan mencegah retry yang bisa menimpa data lebih baru, bukan mekanisme untuk melepas receipt secara manual. Pemulihan restore yang tak bisa dibuktikan dilakukan dari checkpoint yang sudah diverifikasi ke volume staging terpisah.

## Bukti staging

[Foundation 45747073205 — job legacy-panel](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45747073205/job/139665609061) menguji hilangnya callback **buat** dan **restore** pada Wings nyata. Pada skenario buat, Wings berhasil membangun arsip, menolak menganggap callback sukses, lalu menghapus arsip ketika panel tujuan menolak callback. Setelah restart, Relay tetap menyimpan receipt `creating`; pengunduhan, pembuatan ulang, dan penghapusan ditolak, sementara byte file sumber tidak berubah. Ini bukan jaminan arsip selalu hilang saat callback gagal: kegagalan pada waktu lain tetap harus diperiksa mengikuti prosedur di atas.

[Foundation 45752892166 — job legacy-panel](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45752892166/job/139684619508) menyelesaikan alur backup lokal di Chromium melalui HTTPS dan Wings nyata: buat, unduh, kunci (hapus tidak ditawarkan), buka kunci, restore dengan konfirmasi, batalkan hapus, lalu hapus dengan konfirmasi. Isi file checkpoint di dalam arsip unduhan dan isi file pada volume Wings setelah restore dibandingkan byte-for-byte. Semua perubahan backup dikirim dari UI; file pembanding diubah melalui endpoint editor fixture. Ini belum mencakup S3 atau jadwal.
