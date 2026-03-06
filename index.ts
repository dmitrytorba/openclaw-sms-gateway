import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema, normalizeE164 } from "openclaw/plugin-sdk";
import { smsGatewayPlugin, resolveGatewayConfig } from "./src/channel.js";
import { setSmsGatewayRuntime, getRuntime } from "./src/runtime.js";
import { sendSms } from "./src/gateway-api.js";
import type { IncomingMessage, ServerResponse } from "node:http";

let pluginLogger: { info: Function; warn: Function; error: Function; debug: Function } | null = null;

function log(level: "info" | "warn" | "error" | "debug", msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [sms-gateway] ${msg}`;
  if (pluginLogger) {
    pluginLogger[level](line);
  }
  console[level === "debug" ? "log" : level](line);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Parse the Android SMS Gateway webhook payload into a normalized form.
 * The app posts either a flat object or an { event, payload } wrapper.
 */
function parseWebhookPayload(raw: any): {
  event: string;
  phoneNumber: string;
  message: string;
  receivedAt: string;
  messageId?: string;
} | null {
  if (!raw || typeof raw !== "object") return null;

  const inner = raw.payload ?? raw;
  const phoneNumber = inner.sender ?? inner.phoneNumber ?? inner.from ?? raw.from;
  const message = inner.message ?? inner.text ?? inner.body;
  if (!phoneNumber || !message) return null;

  return {
    event: raw.event ?? "sms:received",
    phoneNumber: String(phoneNumber),
    message: String(message),
    receivedAt:
      inner.receivedAt ?? raw.receivedAt ?? new Date().toISOString(),
    messageId: inner.messageId ?? inner.id,
  };
}

const plugin = {
  id: "sms-gateway",
  name: "SMS Gateway",
  description: "Two-way SMS channel via Android SMS Gateway",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    pluginLogger = api.logger as any;
    setSmsGatewayRuntime(api.runtime);
    api.registerChannel({ plugin: smsGatewayPlugin });

    const webhookHandler = async (req: IncomingMessage, res: ServerResponse) => {
        log("info", `webhook hit: ${req.method} ${req.url} from ${req.socket?.remoteAddress}`);

        if (req.method !== "POST") {
          log("warn", `rejected non-POST: ${req.method}`);
          jsonResponse(res, 405, { error: "method not allowed" });
          return;
        }

        const cfg = await api.runtime.config.loadConfig();
        const gatewayCfg = resolveGatewayConfig(cfg);
        log("debug", `gateway mode: ${gatewayCfg.mode}`);

        if (gatewayCfg.webhookSecret) {
          const provided =
            req.headers["x-webhook-secret"] ??
            req.headers["authorization"]?.replace(/^Bearer\s+/i, "");
          if (provided !== gatewayCfg.webhookSecret) {
            log("warn", "webhook secret mismatch — rejecting");
            jsonResponse(res, 401, { error: "unauthorized" });
            return;
          }
        }

        let body: string;
        try {
          body = await readBody(req);
        } catch (err) {
          log("error", `failed reading request body: ${err}`);
          jsonResponse(res, 400, { error: "bad request" });
          return;
        }

        log("debug", `raw body (${body.length} bytes): ${body.slice(0, 500)}`);

        let parsed: any;
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          log("error", `JSON parse failed: ${err}`);
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const sms = parseWebhookPayload(parsed);
        if (!sms) {
          log("warn", `payload missing phoneNumber or message — keys: ${JSON.stringify(Object.keys(parsed))}`);
          jsonResponse(res, 400, { error: "missing phoneNumber or message" });
          return;
        }

        log("info", `inbound SMS from ${sms.phoneNumber}: "${sms.message.slice(0, 100)}"`);

        jsonResponse(res, 200, {
          ok: true,
          received: new Date().toISOString(),
        });

        dispatchSmsInbound(cfg, sms).catch((err) => {
          log("error", `dispatch failed: ${String(err)}\n${(err as Error)?.stack ?? ""}`);
        });
    };

    api.registerHttpRoute({ path: "/sms-gateway/webhook", handler: webhookHandler });
    api.registerHttpRoute({ path: "/webhook/sms", handler: webhookHandler });

    log("info", "registered webhooks at /sms-gateway/webhook and /webhook/sms");
  },
};

async function dispatchSmsInbound(
  cfg: any,
  sms: {
    event: string;
    phoneNumber: string;
    message: string;
    receivedAt: string;
    messageId?: string;
  },
) {
  log("info", `dispatchSmsInbound start — from=${sms.phoneNumber} msg="${sms.message.slice(0, 80)}"`);

  const rt = getRuntime();
  const senderE164 = normalizeE164(sms.phoneNumber) ?? sms.phoneNumber;
  const accountId = "default";
  log("debug", `normalized sender: ${senderE164}`);

  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: "sms-gateway",
    accountId,
    peer: { kind: "user", id: senderE164 },
  });
  log("info", `route resolved — agent=${route.agentId} session=${route.sessionKey} matched=${route.matchedBy}`);

  const now = Date.now();
  const fromLabel = senderE164;
  const toTarget = `sms-gateway:${senderE164}`;

  const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(
    cfg,
    route.agentId,
  );
  log("debug", `envelope options: ${JSON.stringify(envelopeOptions)}`);

  const formattedBody = rt.channel.reply.formatInboundEnvelope({
    channel: "SMS",
    from: fromLabel,
    timestamp: now,
    body: sms.message,
    chatType: "direct",
    envelope: envelopeOptions,
  });
  log("debug", `formatted body: ${formattedBody.slice(0, 200)}`);

  const ctxPayload = rt.channel.reply.finalizeInboundContext({
    Body: formattedBody,
    RawBody: sms.message,
    CommandBody: sms.message,
    From: `sms-gateway:${senderE164}`,
    To: toTarget,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: fromLabel,
    SenderName: senderE164,
    SenderId: senderE164,
    Provider: "sms-gateway",
    Surface: "sms-gateway",
    MessageSid: sms.messageId ?? `sms-${now}`,
    Timestamp: now,
    CommandAuthorized: true,
    OriginatingChannel: "sms-gateway",
    OriginatingTo: toTarget,
  });
  log("debug", `ctx finalized — SessionKey=${ctxPayload.SessionKey} From=${ctxPayload.From} Body=${ctxPayload.Body?.slice(0, 120)}`);

  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  log("debug", `session store path: ${storePath}`);

  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: "sms-gateway",
      to: senderE164,
      accountId,
    },
    onRecordError: (err: any) => {
      log("warn", `session meta update failed: ${err}`);
    },
  });
  log("info", "session recorded, creating dispatcher");

  const gatewayCfg = resolveGatewayConfig(cfg);

  const { dispatcher, replyOptions, markDispatchIdle } =
    rt.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: any) => {
        const text =
          typeof payload === "string"
            ? payload
            : payload?.text ?? payload?.body ?? String(payload);
        log("info", `delivering reply SMS to ${senderE164}: "${text?.slice(0, 120)}"`);
        if (!text?.trim()) {
          log("warn", "skipping empty reply payload");
          return;
        }
        try {
          const result = await sendSms(gatewayCfg, senderE164, text);
          log("info", `SMS sent OK — id=${result.id} state=${result.state}`);
        } catch (err) {
          log("error", `sendSms failed: ${err}\n${(err as Error)?.stack ?? ""}`);
          throw err;
        }
      },
      onError: (err: any, info: any) => {
        log("error", `reply delivery error (${info?.kind}): ${String(err)}`);
      },
    });

  log("info", "dispatching to reply pipeline");
  const { dispatchReplyFromConfig } = rt.channel.reply;
  const result = await dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions,
  });
  log("info", `dispatch complete — queuedFinal=${(result as any)?.queuedFinal}`);

  markDispatchIdle();
  log("info", "dispatchSmsInbound finished");
}

export default plugin;
