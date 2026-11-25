# Runbook latihan pilot staging

**Cakupan:** runner GitHub-hosted disposable, data buatan, satu server Wings. Jangan arahkan workflow ke VPS atau data produksi. Payload **128 MiB dalam 512 file** adalah tolok ukur awal, bukan bukti bahwa ukurannya mewakili kandidat pilot. Catat ukuran dan jumlah file dari kandidat sebelum keputusan pilot.

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
