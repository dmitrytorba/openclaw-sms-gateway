import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk/core";
import { getRuntime } from "./runtime.js";
import { sendSms, type SmsGatewayConfig } from "./gateway-api.js";

function normalizeE164Local(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return (hasPlus ? "+" : "+") + digits;
}

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
    selectionLabel: "SMS Gateway",
    docsPath: "/channels/sms-gateway",
    blurb: "Two-way SMS via Android SMS Gateway",
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
  },
  reload: { configPrefixes: ["channels.sms-gateway"] },
  config: {
    listAccountIds: (_cfg: OpenClawConfig) => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      const section = cfg?.channels?.["sms-gateway"] ?? {};
      return {
        accountId: normalizeAccountId(accountId ?? ""),
        name: section.name ?? "SMS Gateway",
        enabled: section.enabled !== false,
        config: section,
        configured:
          Boolean(section.local?.baseUrl) || Boolean(section.cloud?.baseUrl),
      };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        "sms-gateway": {
          ...cfg.channels?.["sms-gateway"],
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg, accountId }) => {
      const next = { ...cfg, channels: { ...cfg.channels } };
      delete next.channels["sms-gateway"];
      return next;
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg }) =>
      (cfg?.channels?.["sms-gateway"]?.allowFrom ?? []).map(String),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((e) => String(e).trim())
        .filter(Boolean)
        .map((e) => (e === "*" ? "*" : normalizeE164Local(e)))
        .filter(Boolean) as string[],
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "allowlist",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.sms-gateway.dmPolicy",
      allowFromPath: "channels.sms-gateway.allowFrom",
      approveHint: "Add the sender to channels.sms-gateway.allowFrom.",
      normalizeEntry: (raw: string) => normalizeE164Local(raw.trim()) ?? "",
    }),
  },
  messaging: {
    normalizeTarget: (raw: string) => {
      const cleaned = raw.replace(/^sms(-gateway)?:/i, "");
      const e164 = normalizeE164Local(cleaned);
      return e164 ?? undefined;
    },
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string) => {
        const candidate = (normalized ?? raw)?.trim() ?? "";
        return /^\+?\d{7,15}$/.test(candidate);
      },
      hint: "<E.164 phone number>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text: string, limit: number) =>
      getRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 1600,
    sendText: async ({ cfg, to, text }) => {
      const gatewayCfg = resolveGatewayConfig(cfg);
      const result = await sendSms(gatewayCfg, to, text);
      return {
        channel: "sms-gateway",
        messageId: result.id ?? "pending",
        ...result,
      };
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
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
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
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
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
    startAccount: async (ctx) => {
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
