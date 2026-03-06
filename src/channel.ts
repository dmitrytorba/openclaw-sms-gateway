import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeE164,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { getRuntime } from "./runtime.js";
import { sendSms, type SmsGatewayConfig } from "./gateway-api.js";

export interface SmsGatewayChannelConfig {
  enabled?: boolean;
  dmPolicy?: string;
  allowFrom?: string[];
  mode?: "local" | "cloud";
  local?: { baseUrl: string; username: string; password: string };
  cloud?: { baseUrl: string; username: string; password: string };
  webhookSecret?: string;
}

export function resolveGatewayConfig(cfg: any): SmsGatewayConfig {
  const section = cfg?.channels?.["sms-gateway"] ?? {};
  return {
    mode: section.mode ?? "cloud",
    local: section.local,
    cloud: section.cloud,
    webhookSecret: section.webhookSecret,
  };
}

export const smsGatewayPlugin: ChannelPlugin<any> = {
  id: "sms-gateway",
  meta: {
    id: "sms-gateway",
    label: "SMS Gateway",
    icon: "📱",
    category: "chat",
    description: "Two-way SMS via Android SMS Gateway",
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
  },
  reload: { configPrefixes: ["channels.sms-gateway"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg: any, accountId: string) => {
      const section = cfg?.channels?.["sms-gateway"] ?? {};
      return {
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        name: section.name ?? "SMS Gateway",
        enabled: section.enabled !== false,
        config: section,
        configured:
          Boolean(section.local?.baseUrl) || Boolean(section.cloud?.baseUrl),
      };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }: any) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        "sms-gateway": { ...cfg.channels?.["sms-gateway"], enabled },
      },
    }),
    deleteAccount: ({ cfg }: any) => {
      const next = { ...cfg, channels: { ...cfg.channels } };
      delete next.channels["sms-gateway"];
      return next;
    },
    isConfigured: (account: any) => account.configured,
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg }: any) =>
      (cfg?.channels?.["sms-gateway"]?.allowFrom ?? []).map(String),
    formatAllowFrom: ({ allowFrom }: any) =>
      allowFrom
        .map((e: string) => e.trim())
        .filter(Boolean)
        .map((e: string) => (e === "*" ? "*" : normalizeE164(e)))
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, account }: any) => ({
      policy: account.config.dmPolicy ?? "allowlist",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.sms-gateway.dmPolicy",
      allowFromPath: "channels.sms-gateway.",
      normalizeEntry: (raw: string) => normalizeE164(raw.trim()),
    }),
  },
  messaging: {
    normalizeTarget: (input: any) => {
      const raw = typeof input === "string" ? input : input?.to;
      if (!raw) return null;
      const cleaned = raw.replace(/^sms(-gateway)?:/i, "");
      const e164 = normalizeE164(cleaned);
      return e164 ? { to: e164 } : null;
    },
    targetResolver: {
      looksLikeId: (id: string) => /^\+?\d{7,15}$/.test(id?.trim()),
      hint: "<E.164 phone number>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text: string, limit: number) =>
      getRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 1600,
    sendText: async ({ cfg, to, text }: any) => {
      const gatewayCfg = resolveGatewayConfig(cfg);
      const result = await sendSms(gatewayCfg, to, text);
      return { channel: "sms-gateway", messageId: result.id, ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts: any[]) =>
      accounts.flatMap((account: any) => {
        const err =
          typeof account.lastError === "string"
            ? account.lastError.trim()
            : "";
        return err
          ? [
              {
                channel: "sms-gateway",
                accountId: account.accountId,
                kind: "runtime",
                message: `Channel error: ${err}`,
              },
            ]
          : [];
      }),
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }: any) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const account = ctx.account;
      ctx.log?.info(
        `[${account.accountId}] SMS Gateway channel started (webhook mode)`,
      );

      return new Promise<void>((resolve) => {
        const onAbort = () => {
          ctx.abortSignal?.removeEventListener("abort", onAbort);
          ctx.log?.info(`[${account.accountId}] SMS Gateway channel stopped`);
          resolve();
        };
        if (ctx.abortSignal?.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal?.addEventListener("abort", onAbort);
      });
    },
  },
};
