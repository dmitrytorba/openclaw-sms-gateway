/**
 * HTTP client for Android SMS Gateway (https://github.com/capcom6/android-sms-gateway).
 * Supports both local (LAN) and cloud API modes.
 */

export interface SmsGatewayConfig {
  mode: "local" | "cloud";
  local?: { baseUrl: string; username: string; password: string };
  cloud?: { baseUrl: string; username: string; password: string };
  webhookSecret?: string;
}

export interface SendResult {
  id?: string;
  state?: string;
  raw?: unknown;
}

function basicAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

function resolveEndpoint(cfg: SmsGatewayConfig) {
  const mode = cfg.mode ?? "cloud";
  const creds = mode === "cloud" ? cfg.cloud : cfg.local;
  if (!creds) throw new Error(`sms-gateway: no credentials for mode "${mode}"`);
  return { mode, creds };
}

export async function sendSms(
  cfg: SmsGatewayConfig,
  phoneNumber: string,
  message: string,
): Promise<SendResult> {
  const { mode, creds } = resolveEndpoint(cfg);
  const url =
    mode === "cloud"
      ? `${creds.baseUrl}/3rdparty/v1/message`
      : `${creds.baseUrl}/message`;

  const payload =
    mode === "cloud"
      ? { message, phoneNumbers: [phoneNumber] }
      : { textMessage: { text: message }, phoneNumbers: [phoneNumber] };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(creds.username, creds.password),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sms-gateway send failed (${res.status}): ${text}`);
  }

  const body = await res.json();
  return { id: body?.id, state: body?.state, raw: body };
}

export async function fetchMessages(
  cfg: SmsGatewayConfig,
  limit = 10,
): Promise<unknown[]> {
  const { mode, creds } = resolveEndpoint(cfg);
  const url =
    mode === "cloud"
      ? `${creds.baseUrl}/3rdparty/v1/message?limit=${limit}`
      : `${creds.baseUrl}/message?limit=${limit}`;

  const res = await fetch(url, {
    headers: {
      Authorization: basicAuthHeader(creds.username, creds.password),
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sms-gateway fetch failed (${res.status}): ${text}`);
  }

  return (await res.json()) as unknown[];
}
