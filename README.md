# Relay Panel

Relay adalah nama sementara untuk panel manajemen server yang independen dari Pterodactyl. Repositori ini baru berisi fondasi antarmuka: semua server, alamat, dan metrik yang tampil adalah data contoh. Tidak ada koneksi ke Wings atau basis data produksi.

## Jalankan pratinjau

```sh
npm ci
npm run dev
```

Lihat [laporan Tahap 1](docs/stage-1/README.md) untuk daftar berkas, perintah uji, dan batasan. Kajian kompatibilitas ada di [laporan Tahap 0](docs/stage-0/README.md).

Backend identitas untuk staging tersedia terpisah. Lihat [laporan Tahap 2](docs/stage-2/README.md) untuk menyiapkan MySQL lokal dan menguji API. Integrasi antarmuka dengan backend staging dimulai pada [Tahap 4](docs/stage-4/README.md); dashboard masih memakai data contoh.

### Pratinjau UI di GitHub Codespaces

Buat Codespace dari branch kerja, tunggu `npm ci` selesai, lalu jalankan `npm run dev`. Di tab **Ports**, pastikan port **5173** berstatus **Private**, lalu pilih **Open in Browser**. Pratinjau ini memakai data contoh secara default: tidak memulai database, Wings, atau workload, dan tidak menggunakan kredensial produksi. Pengujian migrasi, rollback, dan recovery tetap dijalankan di GitHub Actions.

Untuk mencoba alur login staging tanpa layar demo, gunakan `RELAY_AUTHENTICATED_ENTRY=1 npm run build` dan sajikan hasil build melalui origin yang sama dengan API staging. Opsi build ini tidak mengubah aturan otorisasi server. Pratinjau Codespaces tanpa backend tetap memakai mode demo.
