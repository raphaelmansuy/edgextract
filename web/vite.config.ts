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

/**
 * Keep `dist/models` lean for GitHub Pages / any static host.
 * Local `make demo-webgpu-model` copies ~1 GB of ONNX into public/models; Vite would
 * ship that into dist. Hub Load is the hosted path — only tiny metadata stays.
 */
const KEEP_MODEL_FILES = new Set([".gitkeep", "edgextract-tev1.json", "README.md"]);

function stripModelWeights(): Plugin {
  return {
    name: "strip-model-weights",
    closeBundle() {
      const modelsRoot = path.resolve(import.meta.dirname, "dist/models");
      if (!fs.existsSync(modelsRoot)) return;
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          const st = fs.statSync(full);
          if (st.isDirectory()) {
            walk(full);
            if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
            continue;
          }
          if (KEEP_MODEL_FILES.has(name)) continue;
          fs.unlinkSync(full);
        }
      };
      walk(modelsRoot);
    },
  };
}

// The demo is a static site: `vite build` output can be hosted anywhere.
// `base: "./"` keeps asset URLs relative so it also works from a sub-path.
export default defineConfig({
  base: "./",
  plugins: [modelsStrict404(), transformersNoCache(), stripModelWeights()],
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
