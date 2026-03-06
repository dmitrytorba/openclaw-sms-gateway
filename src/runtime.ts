import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setSmsGatewayRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("sms-gateway runtime not initialized");
  }
  return runtime;
}
