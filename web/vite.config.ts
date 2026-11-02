import { defineConfig } from "vite";

export default defineConfig({
  // Port 8000 deliberately. Vite defaults to 5173, which is a different origin
  // — and every segment would fail CORS until the R2 bucket's policy agreed.
  // Matching the port we already allow-listed keeps that config in one place
  // instead of spread across two dashboards.
  server: { port: 8000 },
});