import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "/onkio/",
  build: { target: "es2022" },
  worker: { format: "es" },
  test: {
    environment: "node",
  },
});
