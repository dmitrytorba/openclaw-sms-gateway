import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveGatewayConfig, smsGatewayPlugin } from "../src/channel.js";

vi.mock("../src/gateway-api.js", () => ({
  sendSms: vi.fn(),
}));

vi.mock("../src/runtime.js", () => ({
  getRuntime: vi.fn(),
}));

import { sendSms } from "../src/gateway-api.js";
import { getRuntime } from "../src/runtime.js";

const sendSmsMock = sendSms as ReturnType<typeof vi.fn>;
const getRuntimeMock = getRuntime as ReturnType<typeof vi.fn>;

const emptyCfg = {} as OpenClawConfig;

describe("resolveGatewayConfig", () => {
  it("returns defaults when section missing", () => {
    expect(resolveGatewayConfig({})).toEqual({
      mode: "cloud",
      local: undefined,
      cloud: undefined,
      webhookSecret: undefined,
    });
  });

  it("merges channels.sms-gateway section", () => {
    const cfg = {
      channels: {
        "sms-gateway": {
          mode: "local" as const,
          local: { baseUrl: "http://x", username: "a", password: "b" },
          webhookSecret: "sec",
        },
      },
    };
    expect(resolveGatewayConfig(cfg)).toEqual({
      mode: "local",
      local: { baseUrl: "http://x", username: "a", password: "b" },
      cloud: undefined,
      webhookSecret: "sec",
    });
  });
});

describe("smsGatewayPlugin config", () => {
  const { config } = smsGatewayPlugin;

  it("listAccountIds returns default account", () => {
    expect(config.listAccountIds!(emptyCfg)).toEqual(["default"]);
  });

  it("resolveAccount marks configured when baseUrl set", () => {
    const acc = config.resolveAccount!(
      {
        channels: {
          "sms-gateway": {
            name: "My SMS",
            cloud: { baseUrl: "https://c", username: "u", password: "p" },
          },
        },
      } as OpenClawConfig,
      "default",
    );
    expect(acc.accountId).toBe("default");
    expect(acc.name).toBe("My SMS");
    expect(acc.enabled).toBe(true);
    expect(acc.configured).toBe(true);
  });

  it("resolveAccount uses DEFAULT_ACCOUNT_ID when accountId empty", () => {
    const acc = config.resolveAccount!(
      { channels: { "sms-gateway": {} } } as OpenClawConfig,
      "",
    );
    expect(acc.accountId).toBe("default");
    expect(acc.configured).toBe(false);
  });

  it("setAccountEnabled toggles enabled flag", () => {
    const next = config.setAccountEnabled!({
      cfg: { channels: { "sms-gateway": { enabled: true } } } as OpenClawConfig,
      accountId: "default",
      enabled: false,
    });
    expect(next.channels!["sms-gateway"]!.enabled).toBe(false);
  });

  it("deleteAccount removes sms-gateway channel", () => {
    const next = config.deleteAccount!({
      cfg: {
        channels: { "sms-gateway": { x: 1 }, other: {} },
      } as OpenClawConfig,
      accountId: "default",
    });
    expect(next.channels!["sms-gateway"]).toBeUndefined();
    expect(next.channels!.other).toEqual({});
  });

  it("isConfigured reflects account.configured", () => {
    expect(config.isConfigured!({ configured: true } as any, emptyCfg)).toBe(
      true,
    );
    expect(config.isConfigured!({ configured: false } as any, emptyCfg)).toBe(
      false,
    );
  });

  it("describeAccount passes through fields", () => {
    expect(
      config.describeAccount!(
        {
          accountId: "a",
          name: "n",
          enabled: true,
          configured: false,
        } as any,
        emptyCfg,
      ),
    ).toEqual({
      accountId: "a",
      name: "n",
      enabled: true,
      configured: false,
    });
  });

  it("resolveAllowFrom maps entries to strings", () => {
    expect(
      config.resolveAllowFrom!({
        cfg: { channels: { "sms-gateway": { allowFrom: [1, " +1 "] } } },
      } as any),
    ).toEqual(["1", " +1 "]);
  });

  it("formatAllowFrom normalizes E164 and keeps star", () => {
    expect(
      config.formatAllowFrom!({
        cfg: emptyCfg,
        allowFrom: ["*", "+1 234 567 8901", "  "],
      }),
    ).toEqual(["*", "+12345678901"]);
  });
});

describe("smsGatewayPlugin security & messaging", () => {
  it("resolveDmPolicy uses defaults and paths", () => {
    const r = smsGatewayPlugin.security!.resolveDmPolicy!({
      cfg: emptyCfg,
      account: { config: {} },
    } as any);
    expect(r!.policy).toBe("allowlist");
    expect(r!.allowFrom).toEqual([]);
    expect(r!.policyPath).toBe("channels.sms-gateway.dmPolicy");
    expect(r!.approveHint).toContain("allowFrom");
    expect(r!.normalizeEntry!("+15551234567")).toBe("+15551234567");
    expect(r!.normalizeEntry!("+1")).toBe("");
  });

  it("normalizeTarget strips sms: prefix and returns E164 string", () => {
    const norm = smsGatewayPlugin.messaging!.normalizeTarget!;
    expect(norm("+14155552671")).toBe("+14155552671");
    expect(norm("sms:+14155552671")).toBe("+14155552671");
    expect(norm("sms-gateway:+441234567890")).toBe("+441234567890");
  });

  it("normalizeTarget returns undefined for invalid input", () => {
    const norm = smsGatewayPlugin.messaging!.normalizeTarget!;
    expect(norm("")).toBeUndefined();
    expect(norm("abc")).toBeUndefined();
  });

  it("targetResolver.looksLikeId matches digit patterns", () => {
    const looks = smsGatewayPlugin.messaging!.targetResolver!.looksLikeId!;
    expect(looks("+1234567")).toBe(true);
    expect(looks("x", "123456789012345")).toBe(true);
    expect(looks("123456")).toBe(false);
    expect(looks("x")).toBe(false);
  });
});

describe("smsGatewayPlugin outbound", () => {
  beforeEach(() => {
    getRuntimeMock.mockReturnValue({
      channel: {
        text: {
          chunkText: (text: string, limit: number) => {
            const out: string[] = [];
            for (let i = 0; i < text.length; i += limit) {
              out.push(text.slice(i, i + limit));
            }
            return out;
          },
        },
      },
    });
    sendSmsMock.mockResolvedValue({ id: "sent-1", state: "ok" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("chunker delegates to runtime chunkText", () => {
    const chunker = smsGatewayPlugin.outbound!.chunker!;
    const parts = chunker("abcdefghij", 3);
    expect(parts).toEqual(["abc", "def", "ghi", "j"]);
  });

  it("sendText calls sendSms with resolved gateway config", async () => {
    const cfg = {
      channels: {
        "sms-gateway": {
          cloud: { baseUrl: "https://x", username: "u", password: "p" },
        },
      },
    } as OpenClawConfig;
    const result = await smsGatewayPlugin.outbound!.sendText!({
      cfg,
      to: "+15551230001",
      text: "out",
    } as any);
    expect(sendSmsMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "cloud" }),
      "+15551230001",
      "out",
    );
    expect(result).toMatchObject({
      channel: "sms-gateway",
      messageId: "sent-1",
      id: "sent-1",
      state: "ok",
    });
  });

  it("sendText uses placeholder messageId when API omits id", async () => {
    sendSmsMock.mockResolvedValue({ state: "ok" });
    const result = await smsGatewayPlugin.outbound!.sendText!({
      cfg: {
        channels: {
          "sms-gateway": {
            cloud: { baseUrl: "https://x", username: "u", password: "p" },
          },
        },
      } as OpenClawConfig,
      to: "+15551230001",
      text: "x",
    } as any);
    expect(result.messageId).toBe("pending");
  });
});

describe("smsGatewayPlugin status", () => {
  const { status } = smsGatewayPlugin;

  it("collectStatusIssues surfaces string lastError", () => {
    const issues = status!.collectStatusIssues!([
      { accountId: "default", lastError: "  boom  " },
    ] as any);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("boom");
  });

  it("collectStatusIssues ignores non-string lastError", () => {
    expect(
      status!.collectStatusIssues!([
        { accountId: "default", lastError: 404 as any },
      ]),
    ).toEqual([]);
  });

  it("buildChannelSummary fills defaults", async () => {
    const summary = await status!.buildChannelSummary!({
      account: {} as any,
      cfg: emptyCfg,
      defaultAccountId: "default",
      snapshot: {} as any,
    });
    expect(summary).toEqual({
      configured: false,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    });
  });

  it("buildAccountSnapshot merges runtime", async () => {
    const snap = await status!.buildAccountSnapshot!({
      account: { accountId: "a", name: "n", enabled: true, configured: true },
      cfg: emptyCfg,
      runtime: { running: true, lastError: "e" },
    } as any);
    expect(snap.running).toBe(true);
    expect(snap.lastError).toBe("e");
  });
});

describe("smsGatewayPlugin gateway.startAccount", () => {
  it("resolves immediately when already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await smsGatewayPlugin.gateway!.startAccount!({
      account: { accountId: "default" },
      abortSignal: ctrl.signal,
      log: { info: vi.fn() },
    } as any);
  });

  it("resolves on abort signal", async () => {
    const ctrl = new AbortController();
    const p = smsGatewayPlugin.gateway!.startAccount!({
      account: { accountId: "default" },
      abortSignal: ctrl.signal,
      log: { info: vi.fn() },
    } as any);
    ctrl.abort();
    await p;
  });
});
