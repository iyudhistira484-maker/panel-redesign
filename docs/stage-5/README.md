# Tahap 5 — kontrol server staging

Irisan pertama menambahkan detail runtime dan start/stop dengan konfirmasi pada daftar server staging. Runtime hanya untuk pemilik atau subuser dengan grant aktif, dan hanya pada workload disposable yang dikenal Relay. Power tetap memeriksa izin `control.start` atau `control.stop` secara terpisah. HTTP 202 bukan bukti perubahan status; UI memverifikasi observasi Wings atau meminta pengguna memperbarui status. Hasil tidak pasti tidak dikirim ulang otomatis.

Pengujian dipisah: Playwright memeriksa konfirmasi serta respons tidak pasti; kontrak adopsi memakai Wings sungguhan untuk keputusan izin dan transisi runtime melalui API. Browser dan Wings belum dijalankan bersama dalam satu skenario. Konsol, reinstall, hapus, dan produksi di luar irisan ini.

## Bukti browser ke Wings

[Job legacy-panel 138929361930](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45532007325/job/138929361930) lulus. Chromium menggunakan frontend terbangun, proxy TLS loopback, sesi MySQL, API Relay HTTP, dan Wings sungguhan tanpa mock. Subuser dengan `activity.read` dapat melihat runtime tetapi start ditolak. Pemilik mengonfirmasi start dan stop, lalu UI memverifikasi `running` dan `offline` dari Wings. Fixture dengan nama yang sama dipilih lewat UUID, bukan urutan daftar. Respons power tidak pasti diuji terpisah melalui simulasi HTTP 502; belum menyimulasikan pemutusan Wings di skenario Chromium langsung.

Run ini tidak hijau penuh: job transfer `mumble-missing-report` gagal terpisah dari skenario browser power. Tidak ada cutover produksi.
