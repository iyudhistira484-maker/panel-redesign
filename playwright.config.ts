import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests',use:{baseURL:'http://127.0.0.1:4173',launchOptions:{executablePath:process.env.RELAY_CHROMIUM_PATH}},webServer:{command:'npm run preview -- --port 4173 --strictPort',url:'http://127.0.0.1:4173'},workers:1});
