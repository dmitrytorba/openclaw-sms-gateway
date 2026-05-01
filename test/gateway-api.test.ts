import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchMessages,
  sendSms,
  type SmsGatewayConfig,
} from "../src/gateway-api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchOnce(impl: (input: RequestInfo, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = vi.fn(impl) as typeof fetch;
}

describe("resolveEndpoint / sendSms", () => {
  it("throws when cloud mode has no cloud credentials", async () => {
    const cfg: SmsGatewayConfig = { mode: "cloud" };
    await expect(sendSms(cfg, "+15551234567", "hi")).rejects.toThrow(
      'no credentials for mode "cloud"',
    );
  });

  it("throws when local mode has no local credentials", async () => {
    const cfg: SmsGatewayConfig = { mode: "local" };
    await expect(sendSms(cfg, "+15551234567", "hi")).rejects.toThrow(
      'no credentials for mode "local"',
    );
  });

  it("defaults mode to cloud when omitted", async () => {
    mockFetchOnce(async (url, init) => {
      expect(String(url)).toBe("https://api.example/3rdparty/v1/message");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        message: "hello",
        phoneNumbers: ["+15551234567"],
      });
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      expect(auth).toMatch(/^Basic /);
      return new Response(JSON.stringify({ id: "m1", state: "sent" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const cfg: SmsGatewayConfig = {
      mode: "cloud",
      cloud: {
        baseUrl: "https://api.example",
        username: "u",
        password: "p",
      },
    };
    const result = await sendSms(cfg, "+15551234567", "hello");
    expect(result).toEqual({
      id: "m1",
      state: "sent",
      raw: { id: "m1", state: "sent" },
    });
  });

  it("uses local endpoint and payload shape", async () => {
    mockFetchOnce(async (url, init) => {
      expect(String(url)).toBe("http://192.168.1.5:8080/message");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        textMessage: { text: "local msg" },
        phoneNumbers: ["+19998887777"],
      });
      return new Response(JSON.stringify({ id: "L1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const cfg: SmsGatewayConfig = {
      mode: "local",
      local: {
        baseUrl: "http://192.168.1.5:8080",
        username: "a",
        password: "b",
      },
    };
    const result = await sendSms(cfg, "+19998887777", "local msg");
    expect(result.id).toBe("L1");
  });

  it("throws with response body on non-OK send", async () => {
    mockFetchOnce(async () => {
      return new Response("rate limited", { status: 429 });
    });
    const cfg: SmsGatewayConfig = {
      mode: "cloud",
      cloud: {
        baseUrl: "https://x",
        username: "u",
        password: "p",
      },
    };
    await expect(sendSms(cfg, "+1", "x")).rejects.toThrow(
      "sms-gateway send failed (429): rate limited",
    );
  });

  it("handles non-JSON success body gracefully", async () => {
    mockFetchOnce(async () => {
      return new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    });
    const cfg: SmsGatewayConfig = {
      mode: "cloud",
      cloud: { baseUrl: "https://x", username: "u", password: "p" },
    };
    await expect(sendSms(cfg, "+1", "x")).rejects.toThrow();
  });
});

describe("fetchMessages", () => {
  it("uses cloud query URL and returns parsed JSON array", async () => {
    mockFetchOnce(async (url, init) => {
      expect(String(url)).toBe(
        "https://api.example/3rdparty/v1/message?limit=5",
      );
      expect(init?.method).toBeUndefined();
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const cfg: SmsGatewayConfig = {
      mode: "cloud",
      cloud: {
        baseUrl: "https://api.example",
        username: "u",
        password: "p",
      },
    };
    const rows = await fetchMessages(cfg, 5);
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("uses local query URL with default limit", async () => {
    mockFetchOnce(async (url) => {
      expect(String(url)).toContain("/message?limit=10");
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const cfg: SmsGatewayConfig = {
      mode: "local",
      local: {
        baseUrl: "http://host",
        username: "u",
        password: "p",
      },
    };
    await fetchMessages(cfg);
  });

  it("throws on failed fetch", async () => {
    mockFetchOnce(async () => new Response("err", { status: 500 }));
    const cfg: SmsGatewayConfig = {
      mode: "cloud",
      cloud: { baseUrl: "https://x", username: "u", password: "p" },
    };
    await expect(fetchMessages(cfg)).rejects.toThrow(
      "sms-gateway fetch failed (500): err",
    );
  });
});
