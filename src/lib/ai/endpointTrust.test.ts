import { describe, expect, it } from "vitest";

import { guessEndpointTrust } from "./endpointTrust";

describe("guessEndpointTrust", () => {
  it("treats loopback as the user's own machine", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:8080/v1",
      // The whole 127/8 block, not only .0.1.
      "http://127.13.9.2:1234/v1",
      "http://[::1]:11434/v1",
    ]) {
      expect(guessEndpointTrust(url)).toBe("trusted");
    }
  });

  it("treats the RFC1918 ranges as the user's own network", () => {
    for (const url of [
      "http://10.0.0.5:11434/v1",
      "http://172.16.0.9:11434/v1",
      "http://172.31.255.254:11434/v1",
      "http://192.168.1.20:11434/v1",
      // Link-local: a machine with no DHCP lease, still not the internet.
      "http://169.254.4.4:11434/v1",
    ]) {
      expect(guessEndpointTrust(url)).toBe("trusted");
    }
  });

  it("does not mistake a public address for a private one", () => {
    for (const url of [
      // 172.32 is outside 172.16/12, and 11.x is not 10.x.
      "http://172.32.0.1:11434/v1",
      "http://11.0.0.1:11434/v1",
      "http://193.168.1.1:11434/v1",
      "https://api.openai.com/v1",
      "https://openrouter.ai/api/v1",
    ]) {
      expect(guessEndpointTrust(url)).toBe("untrusted");
    }
  });

  /** The deployment the whole feature is designed around. */
  it("treats a bare LAN hostname as local", () => {
    for (const url of [
      "http://ai-internal:11434/v1",
      "http://gpu-box.local:11434/v1",
      "http://llm.internal/v1",
      "http://ollama.lan:11434/v1",
    ]) {
      expect(guessEndpointTrust(url)).toBe("trusted");
    }
  });

  /**
   * A field mid-typing must never land on "trusted" — the pre-fill is written
   * to disk once the user stops, and an unparseable intermediate state that
   * guessed generously would leave a real cloud endpoint marked as trusted.
   */
  it("falls back to untrusted for anything it cannot place", () => {
    for (const url of ["", "   ", "http://", "not a url", "https://"]) {
      expect(guessEndpointTrust(url)).toBe("untrusted");
    }
  });

  it("ignores case and surrounding whitespace", () => {
    expect(guessEndpointTrust("  HTTP://LocalHost:11434/v1  ")).toBe("trusted");
  });
});
