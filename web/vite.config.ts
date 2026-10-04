import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

// COOP/COEP make the page crossOriginIsolated so the engine worker can
// Atomics.wait on a SharedArrayBuffer while the nested GPU worker scores Tev1.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
} as const;

/**
 * Missing /models/* must 404 (plain text), not fall through to index.html.
 * Transformers.js probes `/models/{org}/{name}/…` before Hub; a 200 HTML SPA
 * page is then JSON.parsed as config → `Unexpected token '<' … <!doctype`.
 * Apply to both `vite` and `vite preview` (demo often runs on :4273).
 */
function modelsStrict404(): Plugin {
  const attach = (middlewares: {
    use: (fn: (req: { url?: string }, res: {
      statusCode: number;
      setHeader: (k: string, v: string) => void;
      end: (b: string) => void;
    }, next: () => void) => void) => void;
  }, root: string) => {
    middlewares.use((req, res, next) => {
      const raw = req.url?.split("?")[0] ?? "";
      if (!raw.startsWith("/models/")) return next();
      const file = path.join(root, "public", decodeURIComponent(raw.slice(1)));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not found");
        return;
      }
      next();
    });
  };
  return {
    name: "models-strict-404",
    configureServer(server) {
      attach(server.middlewares, server.config.root);
    },
    configurePreviewServer(server) {
      attach(server.middlewares, server.config.root);
    },
  };
}

/** Avoid sticky browser caches of @huggingface/transformers across upgrades (3.x → 4.x). */
function transformersNoCache(): Plugin {
  return {
    name: "transformers-no-cache",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.includes("@huggingface/transformers") || req.url?.includes("onnxruntime-web")) {
          res.setHeader("Cache-Control", "no-store, must-revalidate");
        }
        next();
      });
    },
  };
}

// The demo is a static site: `vite build` output can be hosted anywhere.
// `base: "./"` keeps asset URLs relative so it also works from a sub-path.
export default defineConfig({
  base: "./",
  plugins: [modelsStrict404(), transformersNoCache()],
  server: {
    port: 5273,
    strictPort: true,
    headers: {
      ...isolation,
      // Demo deps change under us (transformers 3→4); never serve a stale copy.
      "Cache-Control": "no-store",
    },
    // The sample notes are read straight from ../data/golden/docs.
    fs: { allow: [".."] },
  },
  preview: { port: 4273, strictPort: true, headers: isolation },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: false },
  optimizeDeps: {
    // Keep out of the dep optimizer: ORT wasm / workers resolve their own URLs.
    exclude: ["@huggingface/transformers"],
  },
});
