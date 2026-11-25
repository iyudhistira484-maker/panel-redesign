# Tahap 5 — kontrol server staging

Irisan pertama menambahkan detail runtime dan start/stop dengan konfirmasi pada daftar server staging. Runtime hanya untuk pemilik atau subuser dengan grant aktif, dan hanya pada workload disposable yang dikenal Relay. Power tetap memeriksa izin `control.start` atau `control.stop` secara terpisah. HTTP 202 bukan bukti perubahan status; UI memverifikasi observasi Wings atau meminta pengguna memperbarui status. Hasil tidak pasti tidak dikirim ulang otomatis.

Pengujian dipisah: Playwright memeriksa konfirmasi serta respons tidak pasti; kontrak adopsi memakai Wings sungguhan untuk keputusan izin dan transisi runtime melalui API. Browser dan Wings belum dijalankan bersama dalam satu skenario. Konsol, reinstall, hapus, dan produksi di luar irisan ini.

## Bukti browser ke Wings

[Job legacy-panel 138929361930](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45532007325/job/138929361930) lulus. Chromium menggunakan frontend terbangun, proxy TLS loopback, sesi MySQL, API Relay HTTP, dan Wings sungguhan tanpa mock. Subuser dengan `activity.read` dapat melihat runtime tetapi start ditolak. Pemilik mengonfirmasi start dan stop, lalu UI memverifikasi `running` dan `offline` dari Wings. Fixture dengan nama yang sama dipilih lewat UUID, bukan urutan daftar. Respons power tidak pasti diuji terpisah melalui simulasi HTTP 502; belum menyimulasikan pemutusan Wings di skenario Chromium langsung.

Run ini tidak hijau penuh: job transfer `mumble-missing-report` gagal terpisah dari skenario browser power. Tidak ada cutover produksi.

## Wings tidak merespons saat aksi dikirim

[CI 45532834159](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45532834159) lulus semua 13 job. Dalam job `legacy-panel`, Chromium sudah melihat runtime `offline` sebelum harness menghentikan sementara daemon Wings disposable. Start yang dikonfirmasi mendapat HTTP 502; UI melaporkan hasil tidak diketahui, tidak mengklaim sukses, menyembunyikan tombol Start, dan tidak mengirim ulang. Pembaruan status saat daemon masih berhenti menampilkan status tidak tersedia. Setelah daemon dilanjutkan, browser membaca kembali status aktual tanpa mengasumsikan perintah lama dibatalkan. Skenario ini menutup pengujian awal kontrol power staging, bukan seluruh Tahap 5 atau gate produksi.

## Cuplikan penggunaan sumber daya

Pada detail server staging, **Baca penggunaan sumber daya** menampilkan cuplikan CPU, memori dan batasnya, disk, waktu aktif, serta byte jaringan yang diterima/dikirim. Satu permintaan mengambil satu cuplikan Wings; Relay tidak mengirim kredensial Wings ke browser, tidak melakukan polling, dan membersihkan cuplikan lama saat refresh. API hanya menerima sesi pemilik pada fixture disposable yang terpasang. Grant baca runtime tidak memberi akses metrik.

[CI 45533251879](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45533251879) lulus semua 13 job. Chromium tanpa mock menampilkan cuplikan dari Wings saat workload aktif dan membuktikan subuser baca-saja ditolak, selain regresi Start/Stop dan timeout.

## Cuplikan konsol baca-saja

Pada detail server staging, **Baca konsol staging** mengambil maksimal 20 baris penanda `RELAY_CONTRACT_READY` dari Wings. Ini sengaja bukan konsol umum: output lain tidak diteruskan karena belum ada kebijakan untuk menangani rahasia pada log workload. Tidak ada input perintah, streaming, atau kredensial Wings di browser. Endpoint hanya untuk sesi pemilik fixture terpasang.

[Job browser → Wings 138936080772](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45534025222/job/138936080772) lulus: pemilik melihat penanda dari workload, subuser baca-saja ditolak, dan saat daemon Wings dijeda UI menghapus cuplikan lama dan menampilkan galat. Satu job transfer Mumble terpisah gagal pada run yang sama.

## Checksum arsip transfer Wings

Kode penerima Wings v1.13.5 menghitung SHA-256 lewat `TeeReader` selama ekstraksi. Ekstraktor dapat berhenti di EOF TAR sebelum EOF bagian multipart; `NextPart` membuang sisa bagian tanpa melewati pembaca hash. [Reproduksi Go](../../patches/wings/checksum_test.go) menunjukkan hash parsial menolak arsip valid, membaca sisa bagian memulihkan kecocokan, dan perubahan satu byte tetap ditolak oleh perbandingan hash. Ini membuktikan cacat cakupan hash, bukan atribusi pasti setiap kegagalan historis (digest lengkap tidak ditangkap pada kejadian lama).

[Kandidat patch](../../patches/wings/v1.13.5-transfer-checksum.patch) menghabiskan sisa bagian lewat pembaca hash sebelum membandingkan checksum. Hanya receiver disposable matriks transfer yang dibangun dari commit upstream `3236480d078c09b823b8a8f21dab76c4029608a5` dengan patch; sender tetap biner resmi. Relay masih mewajibkan bukti tujuan dan pemeriksaan tree digest sebelum finalisasi. [CI 45535781009](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45535781009) lulus semua 13 job, termasuk kedua skenario Mumble dan same-pair. Arsip rusak diuji pada reproduksi hash Go, bukan sebagai unggahan Wings langsung. Patch belum dipasang di VPS/produksi atau diterima upstream.
