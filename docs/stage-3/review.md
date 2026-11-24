# Paket review Tahap 3

**Bukti utama:** [Foundation 45501719828](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45501719828), 12 job lulus setelah rerun satu job. Pada percobaan pertama Wings menolak arsip Mumble skenario laporan hilang karena checksum transport berbeda. Rerun adalah percobaan CI terpisah dengan database dan daemon baru, bukan retry atas operasi yang dikarantina. Penyebab mismatch intermiten belum dipastikan.

| Kriteria | Bukti staging | Batas |
| --- | --- | --- |
| Dry-run, impor dan rollback | `legacy-panel`: Panel v1.15.2, salinan MariaDB, impor tiga baris katalog dengan dua pemilik dan dua grant, replay idempoten serta tes konflik atomik pada latihan adopsi. Dua workload nyata dialihkan, akun aktif lewat Mailpit, izin dibuktikan lewat API dan Wings, lalu rollback dengan UUID, container, dan checksum tetap. | Baris ketiga sintetis. Apply masih shell yang ditinjau, akun uji yang dipetakan eksplisit, alokasi primer, dan node loopback; bukan importer Panel umum. |
| Egg upstream | `lifecycle` Mumble (installer asli, INI, dan `MAX_USERS` valid/tidak valid). `gitea-qualification` Gitea (installer Debian asli, binary ELF, start–stop). Kedua dokumen disimpan dan diekspor byte persis. | Dokumen terpilih saja. Gitea memakai profil fixed versi 1.25.5, bukan override umum. Tag image installer/runtime belum dikunci ke digest. |
| Transfer non-shell | `mumble-reported` dan `mumble-missing-report` memakai upstream Mumble dengan konfigurasi yang sudah ada. Sukses: callback, restart Relay, checksum INI, atomik pindah node; tujuan start/stop dengan `port=25611` dan `users=37`. Ambigu: arsip mendarat, laporan tidak dipersisten, restart sumber, fase `uncertain`, sumber dan reservasi tetap ada, tanpa pengiriman ulang. Skenario HTTP juga lulus. | Satu server per pasangan instans staging; checksum Relay satu file saksi, bukan seluruh pohon file. Tes Mumble transfer tidak mengandalkan installer APK untuk mengambil konfigurasi baru; CI menyemai konfigurasi, sedangkan instalasi bersih diuji oleh `lifecycle`. |

Paket ini siap untuk meninjau bukti tiga sasaran staging. [Gate pengganti Panel](replacement-gate.md) masih terbuka untuk importer produksi, cakupan egg umum, transfer katalog umum dan pemulihan hasil ambigu. Lulus matriks staging tidak menutup gate itu. Tidak ada cutover produksi atau pekerjaan Tahap 4.

## Pembaruan: integritas pohon file transfer

[CI 45503126317](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45503126317) lulus 12 job. Relay kini menyimpan SHA-256 kanonis pohon workload saat dispatch, lalu memverifikasi pohon sumber dan tujuan terhadap nilai awal sesudah callback dan restart, sebelum cutover. Cakupan digest: nama direktori, path, panjang, dan byte mentah file reguler yang berhasil diinventarisasi lewat Wings. Jalur sukses HTTP dan Mumble masing-masing menambahkan satu file tersembunyi yang tidak ada di sumber: finalisasi ditolak dan katalog tetap pada sumber. Setelah file uji dihapus, finalisasi dan start/stop tujuan lulus. Jalur ambigu tetap lulus.

Batas: 256 entri, kedalaman 12, total file 32 MiB, deadline enumerasi 30 detik per pohon. Symlink, file khusus, respons tidak konsisten, atau batas terlampaui tidak dapat disahkan. Metode ini tidak menguji metadata POSIX, tidak menghasilkan snapshot atomik bila penulis eksternal aktif, dan tidak menyelidiki akar checksum transport Wings yang pernah gagal. Digest format lama tidak cocok dengan format pohon dan tidak difinalisasi otomatis. Ini menggantikan bukti satu file saksi untuk staging; pemilihan satu server per pasangan instans, variasi katalog legacy, dan cakupan egg umum tetap terbuka.

## Pembaruan: alokasi tambahan dari Panel nyata

[CI 45504133637](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45504133637) lulus 12 job. Snapshot Panel memuat alokasi utama `127.0.0.1:25610` dan tambahan `127.0.0.2:25616` untuk server pertama. Relay mengimpor IP/port tambahan dan mengaitkannya ke UUID server serta node yang sama; endpoint Wings menyajikan kedua mapping ke node yang benar dan tidak menyajikan alokasi tambahan ke node lain. Tes konflik UUID pada insert alokasi tambahan membatalkan seluruh katalog. Latihan cutover dan rollback dua workload tetap mempertahankan UUID, container dan checksum fixture. Setelah impor, alokasi tambahan tidak bisa dipesan sebagai alokasi bebas; transfer server dengan alokasi tambahan ditolak sampai pemetaan target didukung.

Bukti ini masih loopback dan tidak menguji alokasi publik. Dua sasaran lain (engine egg tanpa adapter per egg dan dua transfer pada pasangan node sama) belum lulus.

## Pembaruan: compiler egg bersama

[CI 45505984824](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45505984824) lulus semua 12 job. HTTP PTDL v1/v2, Mumble dan Gitea kini memakai compiler yang sama untuk aturan variabel, image tunggal, placeholder, parser JSON/properties/INI/file, readiness dan stop. Installer asli tetap dipakai. Tes menolak enum/range salah, variabel asing, karakter shell dan aturan tidak didukung sebelum menghasilkan konfigurasi installer. Yang berbeda per profil hanya data persetujuan dokumen, input staging, dan batas sumber daya. Dokumen baru masih perlu review dan persetujuan byte eksak; belum ada egg upstream ketiga yang dikualifikasi hanya dengan menambah data. Belum ada skenario dua transfer pada pasangan Wings yang sama.

## Pembaruan: dua transfer pada pasangan node yang sama (MySQL)

[CI 45506638643](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45506638643) lulus 12 job. Job `identity` membuat dua transfer aktif pada pasangan node yang sama, dengan UUID, digest, dan alokasi tujuan berbeda. Laporan dan penyelesaian transfer pertama hanya memindahkan server pertama. Instans ledger baru membaca penyimpanan yang sama dan mengarantina transfer kedua; sumber, digest, serta reservasinya tetap utuh dan laporan terlambat maupun klaim ulang ditolak. Ini bukti isolasi database, bukan dua upload Wings bersamaan atau restart proses Relay untuk skenario gabungan. Bagian tersebut dan validasi egg baru yang hanya menambah data persetujuan masih diperlukan untuk review penutupan.

## Penutupan dua tes tersisa untuk cakupan staging

[CI 45507695633](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45507695633) lulus 13 job, termasuk:

- **Dua transfer nyata pada satu pasangan Wings (`same-pair`).** Dua workload HTTP dengan UUID, isi pohon, dan alokasi berbeda dikirim bersamaan. Dua daemon menggunakan Docker engine terpisah. Harness hanya menyuntikkan hilangnya satu callback dan meneruskan callback sukses ke aplikasi tujuan asli. Setelah restart proses Relay sumber, transfer tanpa laporan dikarantina tanpa replay, dengan pohon sumber dan reservasi tetap utuh. Transfer sukses difinalisasi setelah cek pohon dan bisa start/stop di Wings tujuan. Hasil tidak tertukar.
- **Egg upstream baru lewat data persetujuan.** Forgejo memakai dokumen upstream byte-persis dan satu entri `api/eggs/upstream/approved.json` berisi SHA-256, input, dan resource limits. Gitea dan Forgejo berjalan melalui loader, compiler, serta tes lifecycle yang sama; tidak ada adapter Forgejo. Job memverifikasi executable ELF, installer asli, `running`, stop, dan delete. Egg baru masih memerlukan peninjauan serta persetujuan eksplisit.

Tiga sasaran yang dibatasi untuk review staging (alokasi tambahan, egg berbasis approval, dan dua transfer pada satu pair) telah terbukti. Ini bukan klaim kompatibilitas seluruh katalog produksi atau semua format egg; [gate pengganti Panel](replacement-gate.md) tetap mendokumentasikan batasnya. Tidak ada cutover atau implementasi Tahap 4.
