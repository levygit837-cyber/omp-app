import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/** Vite's dev server injects <style> tags, so only `serve` relaxes style-src; the built CSP stays strict. */
const devStyleCsp: Plugin = {
  name: "dev-style-csp",
  apply: "serve",
  transformIndexHtml: (html) =>
    html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
};

export default defineConfig({
  main: { build: { rollupOptions: { input: resolve("src/main/index.ts") } } },
  preload: {
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        // A sandboxed preload must be CommonJS; the package is `type: module`, hence `.cjs`.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
    plugins: [react(), tailwindcss(), devStyleCsp],
  },
});
