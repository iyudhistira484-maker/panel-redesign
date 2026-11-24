# Relay Panel

Relay adalah nama sementara untuk panel manajemen server yang independen dari Pterodactyl. Repositori ini baru berisi fondasi antarmuka: semua server, alamat, dan metrik yang tampil adalah data contoh. Tidak ada koneksi ke Wings atau basis data produksi.

## Jalankan pratinjau

```sh
npm ci
npm run dev
```

Lihat [laporan Tahap 1](docs/stage-1/README.md) untuk daftar berkas, perintah uji, dan batasan. Kajian kompatibilitas ada di [laporan Tahap 0](docs/stage-0/README.md).

Backend identitas untuk staging tersedia terpisah. Lihat [laporan Tahap 2](docs/stage-2/README.md) untuk menyiapkan MySQL lokal dan menguji API. Integrasi antarmuka dengan backend staging dimulai pada [Tahap 4](docs/stage-4/README.md); dashboard masih memakai data contoh.
