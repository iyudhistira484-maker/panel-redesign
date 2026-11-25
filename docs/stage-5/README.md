# Tahap 5 — kontrol server staging

Irisan pertama menambahkan detail runtime dan start/stop dengan konfirmasi pada daftar server staging. Runtime hanya untuk pemilik atau subuser dengan grant aktif, dan hanya pada workload disposable yang dikenal Relay. Power tetap memeriksa izin `control.start` atau `control.stop` secara terpisah. HTTP 202 bukan bukti perubahan status; UI memverifikasi observasi Wings atau meminta pengguna memperbarui status. Hasil tidak pasti tidak dikirim ulang otomatis.

Pengujian dipisah: Playwright memeriksa konfirmasi serta respons tidak pasti; kontrak adopsi memakai Wings sungguhan untuk keputusan izin dan transisi runtime melalui API. Browser dan Wings belum dijalankan bersama dalam satu skenario. Konsol, reinstall, hapus, dan produksi di luar irisan ini.
