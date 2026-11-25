# Runbook latihan pilot staging

**Cakupan:** runner GitHub-hosted disposable, data buatan, satu server Wings. Jangan arahkan workflow ke VPS atau data produksi. Payload **256 MiB dalam 2.048 file** adalah tolok ukur awal, bukan bukti bahwa ukurannya mewakili kandidat pilot. Catat ukuran dan jumlah file dari kandidat sebelum keputusan pilot.

## Persiapan operator

1. Pastikan `RELAY_RECOVERY_RECIPIENT_CERT` tersimpan sebagai Actions Variable dan `RELAY_RECOVERY_RECIPIENT_KEY` sebagai Actions Secret. Gunakan pasangan staging yang sudah terpasang jika masih berlaku.
2. Buat seed 32 byte acak yang **berbeda** dari kunci penerima: `openssl rand -hex 32`. Masukkan hasilnya langsung sebagai repository Actions Secret `RELAY_RECOVERY_RUNTIME_SEED`; jangan kirim lewat chat atau commit. Kedua runner memakai seed ini untuk memperoleh kunci Relay dan token Wings utama yang sama per run. Arsip tidak membawa kunci tersebut dalam mode ini. Amplop fixture yang terpisah tetap membawa sesi pengujian, bukan material untuk produksi.
3. Di **Actions → Relay Wings off-host staging**, pilih branch kerja, biarkan `require_independent_keys` aktif, lalu jalankan. Dengan `gh`: `gh workflow run offhost-recovery.yml --ref arena/74509f28-panel-redesign -f require_independent_keys=true`. Nilai `false` hanya untuk pembanding, bukan bukti jalur kunci independen.

## Pemeriksaan dan keputusan

- Pastikan kedua job lulus. Paket rusak harus ditolak tanpa direktori hasil. MySQL dan Wings harus baru; workload harus membaca seluruh payload dari mount yang dipulihkan.
- Pastikan sesi kolaborator mula-mula kembali sesuai checkpoint, lalu pencabutan izin diterapkan ulang melalui API dan akses kembali `404`. Pastikan pemilik tetap dapat mengakses. File yang ditulis setelah checkpoint tidak ikut pulih.
- Untuk latihan ini, batasnya **120 detik** dari sebelum unduh artefak hingga verifikasi file dan pencabutan ulang (runner, instalasi dependensi dan layanan MySQL sudah siap), serta **30 detik** dari checkpoint hingga simulasi kehilangan di sumber. Keduanya diperiksa oleh tes. Ukur startup/antrean terpisah sebelum membuat target end-to-end. Catat perubahan yang hilang; jendela simulasi bukan RPO operasional.
- Jika gagal, hentikan keputusan pilot. Jangan memakai data dari sumber untuk menyelamatkan uji tujuan, memperlonggar pemeriksaan, atau mengganti kunci di tengah run. Gunakan checkpoint valid dan jalankan ulang **kedua job** setelah penyebab diperbaiki.
- Untuk keputusan pilot produksi, operator kedua perlu mengulang runbook, menggunakan ukuran yang mewakili kandidat, jalur kunci dengan kontrol akses terpisah, dan anggaran pemulihan yang disepakati. Jangan memindahkan trafik dari hasil CI ini saja.

## Bukti pembanding

[CI 45642598694](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45642598694): kedua job lulus. Payload 128 MiB / 512 file dibaca dan checksum cocok dari workload Wings yang dipulihkan. Pencabutan izin diterapkan ulang melalui API. Waktu pemulihan termasuk unduhan artefak **18.804 ms**; checkpoint ke simulasi kehilangan **62 ms**. Keduanya di bawah batas latihan. Run ini memakai mode pembanding (`independent_keys=false`); belum membuktikan mode operator dengan seed independen. [Foundation 45642599572](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45642599572) juga lulus, termasuk tes derivasi kunci.

## Bukti mode kunci independen

[CI 45644310891](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45644310891): kedua job lulus dengan `independent_keys=true`. Runner memperoleh kunci runtime dari secret terpisah, bukan dari artefak. Pemulihan 128 MiB / 512 file, termasuk unduhan dan pencabutan ulang, selesai dalam **23.209 ms**; checkpoint ke simulasi kehilangan **77 ms**. Keduanya memenuhi batas latihan, bukan SLA produksi. Berikutnya: pilih satu kandidat pilot, dokumentasikan ukuran dan jumlah file tanpa menyalin data produksi, lalu minta operator kedua mengulang runbook dengan fixture setara serta menyepakati batas end-to-end dan kondisi rollback.

## Profil pilot kecil yang dipilih

[CI 45645682262](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45645682262) lulus dengan kunci runtime independen dan **256 MiB / 2.048 file** (data sintetis pada workload shell Wings, bukan aplikasi tertentu). Restore termasuk unduh dan pencabutan ulang memakan **19.663 ms**; checkpoint hingga simulasi kehilangan **209 ms**. Keduanya lulus batas latihan. [Foundation 45645681348](https://github.com/iyudhistira484-maker/panel-redesign/actions/runs/45645681348) lulus. Profil ini cukup untuk pilot staging kecil; tidak menyatakan dukungan untuk beban yang lebih besar atau karakteristik aplikasi seperti database aktif. Operator kedua masih perlu mengulang secara mandiri sebelum mempertimbangkan pilot produksi.

## Serah terima ke operator kedua

Minta operator yang tidak menyiapkan latihan awal menjalankan workflow sendiri dari tab **Actions**, pada commit yang sudah ditinjau. Operator tidak perlu melihat nilai secret: workflow mengambilnya langsung. Pertahankan `require_independent_keys=true`. Pengulangan oleh penulis harness tidak dihitung sebagai verifikasi operator kedua.

Catat di tiket atau PR, tanpa kredensial atau isi artefak:

| Bukti | Diisi oleh operator |
| --- | --- |
| Operator, waktu UTC, commit, URL run | Belum diisi |
| Kedua job lulus dan `independent_keys=true` | Belum diverifikasi |
| 256 MiB / 2.048 file dan checksum lulus | Belum diverifikasi |
| Arsip rusak ditolak dan izin dicabut ulang | Belum diverifikasi |
| Waktu pemulihan ≤120 detik dan checkpoint hingga simulasi kehilangan ≤30 detik | Belum diverifikasi |
| Langkah yang tidak dapat diikuti tanpa bantuan | Belum dicatat |
| Keputusan staging: lanjut atau tahan, beserta alasan | Menunggu operator |

Jika salah satu bukti tidak tersedia, tandai **tahan**, jangan setujui cutover. Setelah run independen lulus, pilih satu layanan staging yang benar-benar bisa menerima permintaan. Tambahkan pemeriksaan kesehatan dari sisi pengguna dan uji penulisan baru setelah pemulihan; pengujian shell hanya membuktikan pembacaan file. Untuk keputusan produksi, tentukan target downtime dan kehilangan data, penanggung jawab keputusan, dan prosedur rollback yang teruji untuk tipe workload itu.

## Uji layanan HTTP setelah restore

Workflow menambahkan layanan HTTP disposable di workload Wings yang sama, pada alokasi loopback. Setelah restore, runner melakukan GET dan mencocokkan isi checkpoint, POST record baru, GET ulang, lalu stop/start workload dari Wings dan GET lagi untuk membuktikan record baru tetap ada. Endpoint fixture hanya menulis satu record berukuran maksimum 64 byte; jangan gunakan sebagai layanan produksi. Pemeriksaan HTTP ikut dihitung dalam batas 120 detik.

Status saat implementasi: GET, POST, baca ulang, dan persistensi setelah restart lulus pada BusyBox lokal; lint dan build lulus. Bukti lintas runner menunggu push dan dispatch GitHub. Uji mandiri operator belum dilakukan karena dispatch CLI operator gagal dengan 403; ini tidak dihitung sebagai kelulusan operator.
