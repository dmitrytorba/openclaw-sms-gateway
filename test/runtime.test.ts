import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntime,
  resetSmsGatewayRuntime,
  setSmsGatewayRuntime,
} from "../src/runtime.js";

describe("runtime", () => {
  afterEach(() => {
    resetSmsGatewayRuntime();
  });

  it("getRuntime throws before initialization", () => {
    expect(() => getRuntime()).toThrow("sms-gateway runtime not initialized");
  });

  it("setSmsGatewayRuntime allows getRuntime to return the same object", () => {
    const fake = { kind: "test" } as any;
    setSmsGatewayRuntime(fake);
    expect(getRuntime()).toBe(fake);
  });
});
