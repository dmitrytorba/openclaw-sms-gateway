/**
 * Parse the Android SMS Gateway webhook payload into a normalized form.
 * The app posts either a flat object or an { event, payload } wrapper.
 */
export function parseWebhookPayload(raw: unknown): {
  event: string;
  phoneNumber: string;
  message: string;
  receivedAt: string;
  messageId?: string;
} | null {
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  const inner = (obj.payload ?? obj) as Record<string, unknown>;
  const phoneNumber =
    inner.sender ?? inner.phoneNumber ?? inner.from ?? obj.from;
  const message = inner.message ?? inner.text ?? inner.body;
  if (!phoneNumber || !message) return null;

  const eventVal = obj.event ?? "sms:received";
  const receivedAtVal =
    inner.receivedAt ?? obj.receivedAt ?? new Date().toISOString();
  const messageIdVal = inner.messageId ?? inner.id;

  return {
    event: typeof eventVal === "string" ? eventVal : String(eventVal),
    phoneNumber: String(phoneNumber),
    message: String(message),
    receivedAt:
      typeof receivedAtVal === "string"
        ? receivedAtVal
        : String(receivedAtVal),
    messageId:
      messageIdVal === undefined || messageIdVal === null
        ? undefined
        : String(messageIdVal),
  };
}
