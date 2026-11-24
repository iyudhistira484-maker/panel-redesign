# Tahap 1 — Fondasi

Tahap 0 disetujui dengan stack rekomendasi: TypeScript mode ketat, React, Fastify, MySQL 8.4 LTS, Redis, dan Docker Compose. Tahap ini menggunakan React dan Vite untuk pratinjau fondasi. API, basis data, Redis dan worker belum dijalankan atau dikonfigurasi; tidak ada kredensial, autentikasi, sesi, koneksi Wings, impor, atau otomasi. Pratinjau formulir masuk sengaja dinonaktifkan.

## Berkas

- `index.html`, `src/main.tsx`: kerangka aplikasi bersama, navigasi, drawer seluler, pratinjau lima templat (masuk, halaman berjudul, ruang kerja padat, kosong, kesalahan).
- `src/i18n.ts`, `src/fixtures.ts`: nama sementara, kamus Indonesia/Inggris, penyimpanan preferensi dengan fallback, dan data contoh statis. Istilah utama: server, node, backup, konsol, jadwal, alokasi. Alamat, ID, nama server, dan jalur tidak diterjemahkan.
- `src/ui.tsx`, `src/style.css`: token, font Geist lokal, geometri SVG, tombol, input, pilihan, checkbox/switch, tab, badge, tooltip, modal, toast, pagination, spinner, skeleton, dan gaya tabel bersama. Contoh komponen dapat dicoba dari Pengaturan.
- `package.json`, `package-lock.json`, `biome.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`: konfigurasi perkakas, kunci dependensi, dan aturan sumber.
- `.github/workflows/foundation.yml`, `playwright.config.ts`, `tests/foundation.spec.ts`, `scripts/budget.mjs`: konfigurasi CI, tes browser dan pagar ukuran build.
- `README.md`, dokumen ini, dan `THIRD_PARTY_NOTICES.md`: cara menjalankan, catatan tahap dan lisensi font.

## Jalankan dan uji

```sh
npm ci
npm run dev
# Untuk uji build produksi di mesin pengembangan atau CI:
npx playwright install --with-deps chromium
npm run lint
npm run build
npm run budget
npm audit --audit-level=high
npm test
```

Profil anggaran: shell awal ≤85.000 byte JavaScript gzip; ≤225.000 byte total HTML/CSS/JS gzip ditambah aset WOFF2 tanpa kompresi tambahan. Skrip menghitung konservatif semua aset build saat ini. Belum merupakan pengukuran waktu muat pada jaringan nyata; target latensi harus memakai profil jaringan/perangkat yang terukur dan lingkungan stabil.

## Verifikasi

| Pemeriksaan | Hasil |
|---|---|
| Lint, TypeScript ketat, build produksi | Lulus lokal |
| Audit dependensi | 0 kerentanan dilaporkan saat uji |
| Anggaran build | JS 67.612 byte; total 188.176 byte |
| Playwright | 8 lulus lokal pada Chromium 140 alternatif karena unduhan Playwright dibatasi sandbox |
| Responsif | Tidak ada overflow halaman pada 360, 768, 1280 dan 1920 px; tabel dapat digulir, drawer diuji di bawah 960 px |
| Dua bahasa dan templat | Halaman masuk, kosong, kesalahan, ruang kerja, dan pengaturan diuji; preferensi bertahan setelah reload |
| Keyboard | Escape drawer/modal, pengembalian fokus modal dan tab dengan tombol panah diuji; audit WCAG AA menyeluruh belum dilakukan |
| GitHub Actions | Workflow dibuat; hasil run GitHub belum diverifikasi, dan proteksi cabang belum diatur |

Tahap 2 menunggu persetujuan. Verifikasi Wings tetap merupakan gerbang Tahap 3; uji frontend tidak membuktikan kompatibilitas protokol.
