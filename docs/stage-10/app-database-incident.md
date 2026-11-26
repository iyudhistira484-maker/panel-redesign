# Restore database aplikasi yang hasilnya belum pasti (staging)

API fixture hanya mengimpor dump yang identitas serta checksum-nya sudah diverifikasi, ke skema kosong yang ditetapkan operator di instance MySQL lain. Tidak ada parameter untuk mengganti tujuan. MySQL dapat menyimpan sebagian hasil sebelum impor gagal; DDL tidak dapat diasumsikan ikut rollback.

- **`restoring`** berarti Relay sudah mencatat klaim, bukan memastikan impor berhasil. Setelah dua menit tanpa hasil, API memberi `recoveryNeedsReview=1` tanpa mengubah status atau mencoba ulang. Jika database kontrol tidak bisa mencatat hasil, perlakukan `restoring` sebagai belum pasti.
- **`needs_review`** berarti proses impor melaporkan kegagalan dan skema tujuan mungkin berisi perubahan. API menyimpan ID backup, waktu mulai/akhir, dan audit kegagalan. Seluruh restore berikutnya ke binding ini ditolak; tidak ada tombol reset.
- Catat ID binding/backup serta waktunya. Jangan hubungkan aplikasi ke target yang belum diverifikasi. Pastikan proses import lama benar-benar berhenti, amankan bukti dan perubahan baru di target, lalu bandingkan tabel, isi, dan constraint dengan checkpoint. Jangan menghapus atau menimpa target yang bermasalah.
- Untuk mencoba kembali pada fixture ini, sediakan instance/database tujuan **lain yang kosong** dan binding staging baru dengan identitas restore terbatas. Lakukan verifikasi ulang dump dan smoke test aplikasi sebelum menganggap target siap. Jangan memalsukan status, mereset baris, atau mengimpor ke database sumber.

Belum ada pemulihan otomatis, rotasi target di UI/API, atau dukungan produksi.
