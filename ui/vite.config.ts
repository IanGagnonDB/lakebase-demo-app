import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Live mode proxies /api to the deployed app; the CLI token stays in this dev server, never in the browser.
const live = process.env.VITE_API_MODE === "live";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../app/static", emptyOutDir: true },
  server: {
    port: 5173,
    fs: { allow: [".."] }, // content/*.md lives one level up
    proxy: live
      ? {
          "/api": {
            target: process.env.APP_URL,
            changeOrigin: true,
            headers: { Authorization: `Bearer ${process.env.DATABRICKS_TOKEN}` },
          },
        }
      : undefined,
  },
});
