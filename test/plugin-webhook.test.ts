import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway-api.js", () => ({
  sendSms: vi.fn().mockResolvedValue({ id: "mock", state: "sent" }),
}));

import plugin from "../index.js";
import { sendSms } from "../src/gateway-api.js";

const sendSmsMock = sendSms as ReturnType<typeof vi.fn>;

function stubRuntimeChannel(options?: {
  dispatchReject?: Error;
  sessionRecordError?: Error;
}) {
  return {
    routing: {
      resolveAgentRoute: vi.fn().mockReturnValue({
        agentId: "agent",
        sessionKey: "session-key",
        accountId: "default",
        mainSessionKey: "main-session",
        matchedBy: "default",
      }),
    },
    reply: {
      resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
      formatInboundEnvelope: vi.fn().mockReturnValue("[envelope] body"),
      finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ({
        ...ctx,
        SessionKey: "session-key",
      })),
      createReplyDispatcherWithTyping: vi.fn(({ deliver, onError }) => ({
        dispatcher: {
          async __exerciseDeliver() {
            await deliver("");
            await deliver({ text: "  " });
            await deliver("reply text");
            sendSmsMock.mockRejectedValueOnce(new Error("network down"));
            try {
              await deliver("fail me");
            } catch {
              /* deliver rethrows */
            }
            onError(new Error("pipe"), { kind: "test" });
          },
        },
        replyOptions: {},
        markDispatchIdle: vi.fn(),
      })),
      dispatchReplyFromConfig: options?.dispatchReject
        ? vi.fn().mockRejectedValue(options.dispatchReject)
        : vi.fn(async ({ dispatcher }: any) => {
            if (dispatcher?.__exerciseDeliver) {
              await dispatcher.__exerciseDeliver();
            }
            return { queuedFinal: false };
          }),
    },
    session: {
      resolveStorePath: vi.fn().mockReturnValue("/tmp/session-store"),
      recordInboundSession: vi.fn(async (params: any) => {
        if (options?.sessionRecordError) {
          params.onRecordError?.(options.sessionRecordError);
        }
      }),
    },
  };
}

function createRes() {
  const chunks: unknown[] = [];
  const res = {
    writeHead: vi.fn(),
    end: vi.fn((body?: unknown) => {
      chunks.push(body);
    }),
    get bodyText() {
      return String(chunks[0] ?? "");
    },
    get json() {
      try {
        return JSON.parse(this.bodyText);
      } catch {
        return null;
      }
    },
  };
  return res as unknown as ServerResponse & {
    bodyText: string;
    json: Record<string, unknown>;
  };
}

function createReq(params: {
  method: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: string | null;
  failRead?: boolean;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = params.method;
  req.url = "/sms-gateway/webhook";
  req.headers = params.headers ?? {};
  (req as any).socket = { remoteAddress: "127.0.0.1" };

  setImmediate(() => {
    if (params.failRead) {
      req.emit("error", new Error("read fail"));
      return;
    }
    if (params.body != null) {
      req.emit("data", Buffer.from(params.body, "utf-8"));
    }
    req.emit("end");
  });

  return req;
}

describe("plugin HTTP webhook", () => {
  const loadConfig = vi.fn();
  let routes: Array<{ path: string; handler: Function }> = [];
  let lastApi: {
    logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
    runtime: { channel: ReturnType<typeof stubRuntimeChannel> };
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    routes = [];
    loadConfig.mockReset();
    vi.restoreAllMocks();
    sendSmsMock.mockReset();
    sendSmsMock.mockResolvedValue({ id: "mock", state: "sent" });
  });

  async function setupRegister(
    webhookSecret?: string,
    runtimeOpts?: { dispatchReject?: Error; sessionRecordError?: Error },
  ) {
    loadConfig.mockResolvedValue({
      channels: {
        "sms-gateway": webhookSecret
          ? {
              webhookSecret,
              cloud: { baseUrl: "https://x", username: "u", password: "p" },
            }
          : { cloud: { baseUrl: "https://x", username: "u", password: "p" } },
      },
    });
    routes = [];
    const channel = stubRuntimeChannel(runtimeOpts);
    const api = {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      runtime: {
        config: { loadConfig },
        channel,
      },
      registerChannel: vi.fn(),
      registerHttpRoute: vi.fn((p: { path: string; handler: Function }) => {
        routes.push(p);
      }),
    };
    lastApi = api as any;
    await (plugin as any).register(api);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    return routes[0]!.handler;
  }

  it("rejects non-POST with 405", async () => {
    const handler = await setupRegister();
    const res = createRes();
    await handler(createReq({ method: "GET" }), res);
    expect(res.writeHead).toHaveBeenCalledWith(
      405,
      expect.objectContaining({ "Content-Type": "application/json" }),
    );
    expect(res.json).toEqual({ error: "method not allowed" });
  });

  it("returns 401 when webhook secret is set but header wrong", async () => {
    const handler = await setupRegister("secret");
    const res = createRes();
    await handler(
      createReq({
        method: "POST",
        headers: { "x-webhook-secret": "wrong" },
        body: JSON.stringify({ sender: "+15551234567", message: "hi" }),
      }),
      res,
    );
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    expect(res.json).toEqual({ error: "unauthorized" });
  });

  it("accepts Bearer token for webhook secret", async () => {
    const handler = await setupRegister("secret");
    const res = createRes();
    await handler(
      createReq({
        method: "POST",
        headers: { authorization: "Bearer secret" },
        body: JSON.stringify({ sender: "+15551234567", message: "hi" }),
      }),
      res,
    );
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.json.ok).toBe(true);
  });

  it("returns 400 when body read fails", async () => {
    const handler = await setupRegister();
    const res = createRes();
    await handler(createReq({ method: "POST", failRead: true }), res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(res.json).toEqual({ error: "bad request" });
  });

  it("returns 400 for invalid JSON", async () => {
    const handler = await setupRegister();
    const res = createRes();
    await handler(createReq({ method: "POST", body: "not-json" }), res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(res.json).toEqual({ error: "invalid json" });
  });

  it("returns 400 when payload missing phone or message", async () => {
    const handler = await setupRegister();
    const res = createRes();
    await handler(
      createReq({ method: "POST", body: JSON.stringify({ sender: "+1" }) }),
      res,
    );
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(res.json.error).toBe("missing phoneNumber or message");
  });

  it("returns 200 for valid inbound payload and runs dispatch", async () => {
    const handler = await setupRegister();
    const res = createRes();
    await handler(
      createReq({
        method: "POST",
        body: JSON.stringify({
          sender: "+15551234567",
          message: "hello gateway",
        }),
      }),
      res,
    );
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.json.ok).toBe(true);
    expect(res.json.received).toBeDefined();
    await new Promise<void>((r) => setImmediate(r));
    expect(
      lastApi.runtime.channel.reply.dispatchReplyFromConfig,
    ).toHaveBeenCalled();
    expect(sendSmsMock).toHaveBeenCalledTimes(2);
    expect(sendSmsMock).toHaveBeenLastCalledWith(
      expect.any(Object),
      "+15551234567",
      "fail me",
    );
  });

  it("logs when async dispatchSmsInbound rejects", async () => {
    const handler = await setupRegister(undefined, {
      dispatchReject: new Error("boom"),
    });
    const res = createRes();
    await handler(
      createReq({
        method: "POST",
        body: JSON.stringify({
          sender: "+15551234567",
          message: "x",
        }),
      }),
      res,
    );
    await new Promise<void>((r) => setImmediate(r));
    expect(lastApi.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("dispatch failed"),
    );
  });

  it("invokes onRecordError when session meta update fails", async () => {
    const handler = await setupRegister(undefined, {
      sessionRecordError: new Error("meta fail"),
    });
    const res = createRes();
    await handler(
      createReq({
        method: "POST",
        body: JSON.stringify({
          sender: "+15551234567",
          message: "y",
        }),
      }),
      res,
    );
    await new Promise<void>((r) => setImmediate(r));
    expect(lastApi.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("session meta update failed"),
    );
  });
});
