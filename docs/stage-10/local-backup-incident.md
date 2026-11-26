# Backup lokal staging: callback Wings tidak tiba

Prosedur ini untuk fixture Wings staging, bukan instruksi operasi produksi. `202` hanya berarti permintaan diterima. Setelah dua menit tanpa callback, panel meminta pemeriksaan. Tidak ada retry otomatis untuk buat/restore.

1. Catat ID server, ID backup, node, operasi dan waktu kejadian. Pertahankan server offline dan hentikan jalur tulis lain selama pemeriksaan. Jangan sebarkan token node atau tautan unduhan.
2. Periksa log Wings dan Relay untuk ID dan waktu yang sama. Bedakan operasi arsip/restore dari kegagalan mengirim callback. Restart Wings atau Relay tidak membuktikan bahwa restore gagal atau callback akan dikirim ulang.
3. Untuk **buat backup**, bila arsip ada, verifikasi ukuran, integritas, dan isi terhadap checkpoint yang diketahui di salinan terisolasi. Arsip yang ada saja bukan bukti operasi tuntas. Untuk **restore**, amankan snapshot volume terkini dan bandingkan file yang diharapkan dengan checkpoint. Satu file cocok bukan bukti keseluruhan volume cocok; restore non-truncate juga mempertahankan file tambahan.
4. Jika callback sah tiba belakangan, baca status yang baru dan cocokkan dengan bukti. Jika tidak tiba, biarkan receipt tertunda; jangan mengirim callback palsu atau mengubah baris DB untuk memaksa status sukses. Untuk fixture yang boleh dibuang, simpan bukti lalu buat ulang fixture. Jangan mengulangi restore ke volume asli hanya untuk menghapus status pending.

Batas saat ini: prosedur ini mempertahankan bukti dan mencegah retry yang bisa menimpa data lebih baru, bukan mekanisme untuk melepas receipt secara manual. Pemulihan restore yang tak bisa dibuktikan dilakukan dari checkpoint yang sudah diverifikasi ke volume staging terpisah.
