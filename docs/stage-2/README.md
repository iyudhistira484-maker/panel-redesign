# Tahap 2 — Identitas dan akses

Backend Fastify untuk staging menambahkan akun, sesi berbasis cookie, login dengan migrasi bcrypt ke Argon2id, reset kata sandi, TOTP dan kode pemulihan sekali pakai, profil, API key akun, audit dan penyimpanan peristiwa. API belum terhubung ke pratinjau React. Tidak ada node Wings, data atau kredensial produksi, atau fitur otomasi.

## Berkas

- `api/app.ts`, `api/server.ts`: API dan proses lokal, validasi permintaan, header keamanan, pemeriksaan origin, pembatasan permintaan dan pengiriman reset ke Mailpit.
- `api/security.ts`, `api/policy.ts`, `api/provision.ts`: kriptografi, katalog 40 kunci izin, kebijakan akun/server, generator kredensial lokal untuk uji staging.
- `api/db.ts`, `api/migrate.ts`, `api/cli.ts`, `api/events.ts`: transaksi SQL, migrator staging, perintah admin lokal, audit/peristiwa dan pembersihan berbatas.
- `migrations/001_identity.{up,down}.sql`: skema identitas, audit, peristiwa dan throttle; rollback menghapus data identitas **staging**.
- `compose.staging.yml`, `.env.staging.example`, `.gitignore`: konfigurasi MySQL 8.4 dan Mailpit lokal; kata sandi dan kunci tidak masuk Git.
- `api/security.test.ts`, `api/identity.integration.test.ts`, `.github/workflows/foundation.yml`: uji keamanan/policy, skenario integrasi MySQL, dan job CI.
- `README.md`, `docs/stage-2/`, `package*.json`, `tsconfig.json`: dokumentasi dan perkakas.

## Jalankan di staging terisolasi

1. Gunakan Node 22, Docker Compose, basis data kosong dan akun yang tidak mempunyai akses ke basis data lain. `npm ci`; salin `.env.staging.example` ke `.env.staging` dan isi nilai lokal. Buat dua kunci berbeda dengan `openssl rand -base64 32` dan URL-encode kata sandi MySQL di URL koneksi. Jangan kirim file ini ke Git atau chat.
2. `docker compose --env-file .env.staging -f compose.staging.yml up -d --wait`. DB dan Mailpit terikat ke loopback; jangan publikasikan port Mailpit atau DB.
3. `set -a; . ./.env.staging; set +a` lalu `npm run db -- up`. Buat akun uji dengan `npm run db -- create-user operator@example.test`, masukkan kata sandi melalui stdin tanpa menampilkannya atau memasukkannya sebagai argumen, lalu EOF.
4. `npm run api` membuka API loopback pada port 3200 secara default. Untuk browser, tempatkan di balik reverse proxy HTTPS **satu origin** dengan panel dan set `RELAY_ORIGIN` ke origin itu. Jangan ubah cookie menjadi tidak aman. Untuk uji CLI lokal, `GET http://127.0.0.1:3200/health/ready` memastikan skema tersedia; `POST/PATCH/DELETE` perlu header `Origin` yang sama persis dengan `RELAY_ORIGIN` dan `X-Relay-Request: 1`. Jangan log cookie atau header Authorization di proxy. Tautan email reset belum memiliki halaman yang memprosesnya; uji melalui API.
5. `npm run db -- prune` menjalankan pembersihan satu batch. Tidak ada jadwal otomatis saat ini. Untuk membongkar skema pada salinan staging, hentikan API, pastikan backup bisa dipulihkan, lalu `RELAY_CONFIRM_DOWN=drop-staging-identity npm run db -- down`. DDL MySQL tidak transaksional: migrasi terputus ditandai dan tidak diulang diam-diam. Untuk rollback setelah kegagalan, periksa skema sebelum menjalankan `down` atau pulihkan snapshot.

## Kontrak ringkas

| Jalur relatif ke `/api/v1` | Cara pakai |
|---|---|
| `POST /auth/login`, `/auth/challenge`, `/auth/logout` | `{email,password}`, lalu `{code}` bila `twoFactorRequired`. Cookie `Secure`, `HttpOnly`, `SameSite=Strict`; sesi tantangan 5 menit, sesi penuh 12 jam. |
| `POST /auth/forgot-password`, `/auth/reset-password` | `{email}`, lalu `{token,password}`. Respons permintaan selalu 202 untuk input valid; SMTP lokal hanya tujuan `@example.test`. Reset mencabut sesi dan API key, tidak menonaktifkan TOTP. |
| `GET/PATCH /account`, `POST /account/password` | Baca akun sendiri, perbarui `{displayName?,locale?}`, ganti dengan `{currentPassword,newPassword}`. |
| `POST /account/totp/begin`, `/confirm`, `/disable` | Di terminal privat, `npm run provision -- totp` menghasilkan seed, kunci aplikasi autentikator Base32, dan kode pemulihan. Kirim `{password,seed}`, lalu `{code,recoveryCodes}`. Untuk menonaktifkan diperlukan `{password,code}`. API tidak mengembalikan seed/kode. Jangan gunakan generator di CI atau terminal yang merekam output. |
| `GET/POST /account/keys`, `DELETE /account/keys/{id}` | `npm run provision -- api-key`, lalu kirim `{label,key}`. Gabungkan bagian lokal dan `suffix` dari respons dengan titik. API tidak pernah mengembalikan token lengkap. Bearer ini hanya boleh membaca profil sendiri, bukan menulis atau mengakses server. |
| `GET /account/activity` | Audit akun sendiri, maksimal 100 entri. |

## Keputusan dan batasan

- Rahasia TOTP memakai AES-256-GCM dengan versi envelope dan ID pemilik terikat autentikasi. Sesi, reset, recovery dan API key disimpan sebagai verifier HMAC, bukan plaintext. Simpan kunci terpisah dari backup DB. Rotasi pepper mencabut seluruh verifier lama, termasuk kode pemulihan; sebelum rotasi, siapkan jalur pemulihan 2FA. Rotasi kunci TOTP memerlukan prosedur re-enkripsi offline yang diuji; jangan mengganti env begitu saja. Lihat [ADR](adr-006.md).
- bcrypt `$2a$`, `$2b$`, `$2y$` diuji untuk panjang umum. Kandidat kata sandi bcrypt di atas 72 **byte** ditolak agar rehash tidak mengubah arti input yang dipotong diam-diam; kasus tersebut memerlukan reset dan keputusan sebelum migrasi.
- Rate limit Fastify per proses, ditambah throttle akun bertransaksi di MySQL untuk login, challenge dan reset. Pengiriman mail staging bersifat asinkron dan belum punya antrean durabel; reset tidak mengungkap status kirim melalui respons. Redis, SMTP eksternal, UI akses, OpenAPI lengkap, Application API legacy dan pengujian lintas node berada di luar tahap ini. API key terbatas sengaja tidak memberi hak server atau admin.

## Verifikasi

```sh
npm run lint
npm run build
npm run budget
npm audit --audit-level=high
npm run test:identity
```

Untuk skenario MySQL, buat **database kosong yang boleh dihapus** bernama `relay_test`, lalu set `RELAY_ENV=staging`, `RELAY_RUN_MYSQL_TESTS=1` dan `RELAY_STAGING_DATABASE_URL` ke DB tersebut serta ulangi `npm run test:identity`. Job GitHub Actions melakukan ini dengan layanan MySQL. Tes migrasi melakukan `up → down → up`, jadi jangan gunakan basis data staging dengan data berharga.

- Lint, build, audit, dan 5 tes non-DB dijalankan lokal; laporan akhir menyebutkan statusnya.
- Integrasi MySQL, Mailpit dan Compose belum dieksekusi di sandbox ini (tidak ada Docker/MySQL lokal). Hasil GitHub Actions belum terverifikasi. Tes non-DB tidak membuktikan bahwa alur login/reset/2FA lulus end-to-end.
- Tahap 3 tidak dimulai; gerbang berikutnya adalah hasil verifikasi MySQL staging dan persetujuan pengguna.
