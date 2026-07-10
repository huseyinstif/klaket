import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    // Dev mode: forward API calls to a locally running klaket-api.
    proxy: { "/api": { target: "http://localhost:8484", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
