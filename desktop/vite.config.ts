import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  /* The Tauri CSP permits images from `self`, not from `data:`. Vite's default
     inlines small assets, which turned every provider SVG into a data URL: the
     <img> occupied space in the installed app while WebView2 blocked its
     source. Keep the boundary tight and emit every imported asset beside the
     bundle instead of widening the CSP for cosmetic content. */
  build: {
    assetsInlineLimit: 0
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true
  },
  clearScreen: false
});
