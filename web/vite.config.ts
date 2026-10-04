import { defineConfig } from "vite";

// The demo is a static site: `vite build` output can be hosted anywhere.
// `base: "./"` keeps asset URLs relative so it also works from a sub-path.
export default defineConfig({
  base: "./",
  server: {
    port: 5273,
    strictPort: true,
    // The sample notes are read straight from ../data/golden/docs.
    fs: { allow: [".."] },
  },
  preview: { port: 4273, strictPort: true },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: false },
});
