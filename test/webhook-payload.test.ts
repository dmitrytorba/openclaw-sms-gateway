import { describe, expect, it } from "vitest";
import { parseWebhookPayload } from "../src/webhook-payload.js";

describe("parseWebhookPayload", () => {
  it("returns null for non-objects", () => {
    expect(parseWebhookPayload(null)).toBeNull();
    expect(parseWebhookPayload(undefined)).toBeNull();
    expect(parseWebhookPayload("x")).toBeNull();
    expect(parseWebhookPayload(1)).toBeNull();
  });

  it("parses flat payload with sender and message", () => {
    const r = parseWebhookPayload({
      sender: "+15550001111",
      message: "hello",
      receivedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(r).toEqual({
      event: "sms:received",
      phoneNumber: "+15550001111",
      message: "hello",
      receivedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("accepts phoneNumber, from, text, body aliases", () => {
    expect(
      parseWebhookPayload({
        phoneNumber: "+1",
        text: "t",
      })?.message,
    ).toBe("t");
    expect(
      parseWebhookPayload({
        from: "+2",
        body: "b",
      })?.message,
    ).toBe("b");
  });

  it("unwraps nested payload and preserves top-level event", () => {
    const r = parseWebhookPayload({
      event: "custom:event",
      payload: {
        sender: "+33",
        message: "nested",
        messageId: "mid-1",
      },
    });
    expect(r).toMatchObject({
      event: "custom:event",
      phoneNumber: "+33",
      message: "nested",
      messageId: "mid-1",
    });
  });

  it("uses top-level receivedAt when inner omits it", () => {
    const r = parseWebhookPayload({
      sender: "+1",
      message: "m",
      receivedAt: "2026-05-01T12:00:00.000Z",
    });
    expect(r?.receivedAt).toBe("2026-05-01T12:00:00.000Z");
  });

  it("coerces non-string event and receivedAt to string", () => {
    const r = parseWebhookPayload({
      event: 42,
      sender: "+1",
      message: "m",
      receivedAt: 99,
    } as any);
    expect(r?.event).toBe("42");
    expect(r?.receivedAt).toBe("99");
  });

  it("coerces messageId from id", () => {
    const r = parseWebhookPayload({
      sender: "+1",
      message: "m",
      id: 123,
    } as any);
    expect(r?.messageId).toBe("123");
  });

  it("returns null when phone or message missing", () => {
    expect(parseWebhookPayload({ sender: "+1" })).toBeNull();
    expect(parseWebhookPayload({ message: "x" })).toBeNull();
    expect(parseWebhookPayload({})).toBeNull();
  });
});
