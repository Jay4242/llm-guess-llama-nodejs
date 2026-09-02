import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "client",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: [""],
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
