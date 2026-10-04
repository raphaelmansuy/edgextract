/** Default only on a local page. GitHub Pages cannot reach this address. */
export const DEFAULT_OLLAMA_LOOPBACK = "http://127.0.0.1:11434";

export function hostnameIsLoopback(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0:0:0:0:0:0:0:1";
}

export function originIsLocal(origin: string): boolean {
  try {
    return hostnameIsLoopback(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether this tab can talk to the typed Ollama URL.
 * Hosted HTTPS pages (GitHub Pages) cannot use loopback, and the browser
 * blocks mixed-content `http://` fetches.
 */
export function ollamaHostUsable(
  pageOrigin: string,
  hostUrl: string,
): { ok: true } | { ok: false; reason: string } {
  const raw = hostUrl.trim();
  if (!raw) {
    return {
      ok: false,
      reason: originIsLocal(pageOrigin)
        ? `Enter an Ollama host (default ${DEFAULT_OLLAMA_LOOPBACK}).`
        : "This hosted page cannot use 127.0.0.1. Stay on WebGPU, or enter a public HTTPS Ollama URL.",
    };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: `cannot reach ${raw}: invalid URL` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `cannot reach ${raw}: need http(s)` };
  }
  const loop = hostnameIsLoopback(u.hostname);
  if (!originIsLocal(pageOrigin) && loop) {
    return {
      ok: false,
      reason:
        "This hosted page cannot reach 127.0.0.1. Use WebGPU in this tab, or a public HTTPS Ollama host with OLLAMA_ORIGINS set to this origin.",
    };
  }
  try {
    const page = new URL(pageOrigin);
    if (page.protocol === "https:" && u.protocol === "http:" && !loop) {
      return {
        ok: false,
        reason:
          "This page is HTTPS; the browser blocks http:// Ollama (mixed content). Serve Ollama behind HTTPS, or use WebGPU.",
      };
    }
  } catch {
    /* ignore malformed page origin in tests */
  }
  return { ok: true };
}

export function defaultOllamaHost(pageOrigin: string): string {
  return originIsLocal(pageOrigin) ? DEFAULT_OLLAMA_LOOPBACK : "";
}
