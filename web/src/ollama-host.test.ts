import { describe, expect, it } from "vitest";
import {
  DEFAULT_OLLAMA_LOOPBACK,
  defaultOllamaHost,
  hostnameIsLoopback,
  ollamaHostUsable,
  originIsLocal,
} from "./ollama-host";

describe("ollama host on local vs GitHub Pages", () => {
  it("treats loopback names as local", () => {
    expect(hostnameIsLoopback("127.0.0.1")).toBe(true);
    expect(hostnameIsLoopback("localhost")).toBe(true);
    expect(hostnameIsLoopback("::1")).toBe(true);
    expect(hostnameIsLoopback("ollama.example")).toBe(false);
  });

  it("defaults loopback only on a local origin", () => {
    expect(defaultOllamaHost("http://localhost:4273")).toBe(DEFAULT_OLLAMA_LOOPBACK);
    expect(defaultOllamaHost("https://raphaelmansuy.github.io")).toBe("");
  });

  it("lets a local demo talk to 127.0.0.1", () => {
    expect(originIsLocal("http://127.0.0.1:4273")).toBe(true);
    expect(ollamaHostUsable("http://127.0.0.1:4273", DEFAULT_OLLAMA_LOOPBACK).ok).toBe(true);
  });

  it("rejects loopback and mixed-content http from GitHub Pages", () => {
    const pages = "https://raphaelmansuy.github.io";
    expect(originIsLocal(pages)).toBe(false);
    expect(ollamaHostUsable(pages, DEFAULT_OLLAMA_LOOPBACK).ok).toBe(false);
    expect(ollamaHostUsable(pages, "http://example.com:11434").ok).toBe(false);
    expect(ollamaHostUsable(pages, "https://ollama.example").ok).toBe(true);
    expect(ollamaHostUsable(pages, "").ok).toBe(false);
  });
});
