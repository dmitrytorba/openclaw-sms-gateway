# openclaw-sms-gateway

Two-way SMS channel plugin for [OpenClaw](https://openclaw.dev) using [Android SMS Gateway](https://github.com/capcom6/android-sms-gateway).

Turns any Android phone into a full SMS interface for your OpenClaw agent — inbound messages create agent sessions, and agent replies are sent back as SMS.

## How It Works

```
┌──────────┐    SMS     ┌──────────────────────┐   webhook POST    ┌───────────────┐
│          │ ────────▶  │  Android SMS Gateway  │  ──────────────▶  │   OpenClaw     │
│  Phone   │            │  (app on your phone)  │                   │   Gateway      │
│          │ ◀────────  │                       │  ◀──────────────  │                │
└──────────┘    SMS     └──────────────────────┘   API (send SMS)   └───────────────┘
                                                                          │
                                                                          ▼
                                                                    ┌───────────┐
                                                                    │   Agent   │
                                                                    │  Session  │
                                                                    └───────────┘
```

**Inbound flow** (someone texts your Android phone):

1. Android SMS Gateway app receives the SMS
2. The app fires a webhook POST to your OpenClaw gateway at `/sms-gateway/webhook`
3. This plugin parses the sender's phone number and message text
4. It creates or resumes an agent session keyed by the sender's E.164 number
5. The message is dispatched through OpenClaw's reply pipeline
6. The agent processes it and generates a response

**Outbound flow** (agent replies):

1. The agent's reply text is passed to this plugin's `sendSms` function
2. The function calls the Android SMS Gateway API (cloud or local LAN mode)
3. The gateway app sends the SMS from the Android phone
4. The recipient sees it as a normal text message from your phone number

## Features

- **Full two-way conversations** — each phone number gets its own persistent session
- **Cloud and local modes** — use the cloud API (`api.sms-gate.app`) for remote access, or hit the phone directly on your LAN
- **Allowlist security** — restrict which phone numbers can interact with your agent
- **Webhook secret** — optional shared secret to authenticate inbound webhooks
- **SMS chunking** — long agent replies are automatically split at 1600 characters
- **E.164 normalization** — phone numbers are normalized for consistent session routing
- **Graceful webhook handling** — immediate 200 response to prevent gateway retries, async processing

## Prerequisites

- [OpenClaw](https://openclaw.dev) installed and running
- An Android phone with the [Android SMS Gateway](https://github.com/capcom6/android-sms-gateway) app installed
- A way to expose your OpenClaw gateway to the internet (e.g., Cloudflare Tunnel, ngrok, port forwarding) for the webhook to reach it

## Quick Start

### 1. Install the plugin

```bash
# Clone this repo into your plugins directory
git clone https://github.com/dmitrytorba/openclaw-sms-gateway.git ~/.openclaw/plugins/sms-gateway

# Install and enable
openclaw plugins install --link ~/.openclaw/plugins/sms-gateway
openclaw plugins enable sms-gateway
```

### 2. Add configuration to `openclaw.json`

Add the `sms-gateway` section under `channels`:

```jsonc
{
  "channels": {
    "sms-gateway": {
      "enabled": true,
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"],
      "mode": "cloud",
      "cloud": {
        "baseUrl": "https://api.sms-gate.app",
        "username": "YOUR_CLOUD_USERNAME",
        "password": "YOUR_CLOUD_PASSWORD"
      },
      "local": {
        "baseUrl": "http://PHONE_LAN_IP:8080",
        "username": "YOUR_LOCAL_USERNAME",
        "password": "YOUR_LOCAL_PASSWORD"
      },
      "webhookSecret": "optional-shared-secret"
    }
  }
}
```

### 3. Register the webhook with Android SMS Gateway

The webhook tells the SMS Gateway app where to send inbound SMS notifications. Register it via the cloud API:

```bash
curl -X POST -u 'USERNAME:PASSWORD' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://your-domain.com/sms-gateway/webhook","event":"sms:received"}' \
  https://api.sms-gate.app/3rdparty/v1/webhooks
```

Or if using the local API:

```bash
curl -X POST -u 'USERNAME:PASSWORD' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://your-domain.com/sms-gateway/webhook","event":"sms:received"}' \
  http://PHONE_LAN_IP:8080/webhooks
```

### 4. Restart the gateway

```bash
openclaw gateway restart
```

Send a text to your Android phone's number — the agent should reply.

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the channel |
| `dmPolicy` | `string` | `"allowlist"` | `"allowlist"` or `"open"` — controls who can DM the agent |
| `allowFrom` | `string[]` | `[]` | E.164 phone numbers allowed to interact (when `dmPolicy` is `"allowlist"`) |
| `mode` | `string` | `"cloud"` | `"cloud"` to use `api.sms-gate.app`, `"local"` to hit the phone on LAN |
| `cloud.baseUrl` | `string` | — | Cloud API base URL (typically `https://api.sms-gate.app`) |
| `cloud.username` | `string` | — | Cloud API username (from the Android app's cloud registration) |
| `cloud.password` | `string` | — | Cloud API password |
| `local.baseUrl` | `string` | — | Local API base URL (e.g., `http://PHONE_LAN_IP:8080`) |
| `local.username` | `string` | — | Local API username |
| `local.password` | `string` | — | Local API password |
| `webhookSecret` | `string` | — | Optional secret; if set, inbound webhooks must include `X-Webhook-Secret` header |

## Android SMS Gateway API

This plugin interacts with two parts of the Android SMS Gateway:

### Sending SMS (outbound)

**Cloud mode** — `POST https://api.sms-gate.app/3rdparty/v1/message`

```json
{
  "message": "Hello from your agent",
  "phoneNumbers": ["+15551234567"]
}
```

**Local mode** — `POST http://<phone-ip>:8080/message`

```json
{
  "textMessage": { "text": "Hello from your agent" },
  "phoneNumbers": ["+15551234567"]
}
```

Both use HTTP Basic Auth.

### Receiving SMS (inbound webhook)

The app POSTs to your configured webhook URL when an SMS is received. Payload format:

```json
{
  "event": "sms:received",
  "payload": {
    "sender": "+15551234567",
    "message": "Hey, what's up?",
    "receivedAt": "2026-03-06T12:00:00Z",
    "messageId": "abc123"
  }
}
```

The plugin handles multiple payload shapes — it looks for the phone number in `payload.sender`, `payload.phoneNumber`, `payload.from`, or top-level `from`. The message is read from `payload.message`, `payload.text`, or `payload.body`.

### Webhook Management

```bash
# Register a webhook
curl -X POST -u 'USER:PASS' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://your-host/sms-gateway/webhook","event":"sms:received"}' \
  https://api.sms-gate.app/3rdparty/v1/webhooks

# List registered webhooks
curl -u 'USER:PASS' https://api.sms-gate.app/3rdparty/v1/webhooks

# Delete a webhook
curl -X DELETE -u 'USER:PASS' https://api.sms-gate.app/3rdparty/v1/webhooks/<id>
```

## Plugin Architecture

```
sms-gateway/
├── index.ts                 # Entry point — registers channel, webhook routes, dispatch logic
├── openclaw.plugin.json     # Plugin manifest
├── package.json             # Package metadata
└── src/
    ├── channel.ts           # ChannelPlugin implementation (config, security, outbound, status)
    ├── gateway-api.ts       # HTTP client for Android SMS Gateway (send/fetch)
    └── runtime.ts           # PluginRuntime singleton holder
```

### `index.ts` — Plugin Entry Point

- Registers the `sms-gateway` channel with OpenClaw
- Mounts webhook handlers at `/sms-gateway/webhook` (primary) and `/webhook/sms` (compatibility)
- Parses inbound webhook payloads and dispatches them into OpenClaw's session/reply pipeline
- Creates per-sender sessions with E.164-based routing

### `src/channel.ts` — Channel Plugin

Implements the `ChannelPlugin` interface:

- **Config** — account management, enable/disable, allowlist resolution
- **Security** — DM policy enforcement with E.164-normalized allowlists
- **Messaging** — target normalization (strips `sms:` / `sms-gateway:` prefixes, normalizes to E.164)
- **Outbound** — sends replies via `gateway-api.ts`, with text chunking at 1600 chars
- **Status** — runtime status tracking and error reporting
- **Gateway** — keeps the channel alive in webhook mode (no polling needed)

### `src/gateway-api.ts` — SMS Gateway HTTP Client

- `sendSms(cfg, phoneNumber, message)` — sends an SMS through cloud or local API
- `fetchMessages(cfg, limit)` — retrieves recent messages (useful for debugging)
- Handles Basic Auth, timeouts (15s send, 10s fetch), and error reporting

### `src/runtime.ts` — Runtime Holder

Simple singleton pattern that stores the `PluginRuntime` instance provided by OpenClaw during plugin registration. Used by `channel.ts` and `index.ts` to access core utilities.

## Session Routing

Each unique phone number gets its own OpenClaw session. The session key follows the pattern:

```
agent:<agentId>:sms-gateway:user:<e164-phone-number>
```

For example, a text from `+15551234567` to the `main` agent creates session:

```
agent:main:sms-gateway:user:+15551234567
```

This means:
- Each person has a persistent, ongoing conversation with the agent
- Context is maintained across multiple texts
- The agent can reference earlier messages in the same session

## Exposing the Webhook (Cloudflare Tunnel)

The Android SMS Gateway needs to reach your OpenClaw gateway over HTTPS. If your server isn't directly exposed to the internet, you need a tunnel.

### Cloudflare Tunnel Setup

```bash
# Install cloudflared
# See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Create a tunnel (one-time)
cloudflared tunnel create my-tunnel

# Add a DNS route
cloudflared tunnel route dns my-tunnel sms-webhook.example.com

# Run the tunnel
cloudflared tunnel --config ~/.cloudflared/config.yml run
```

Example `~/.cloudflared/config.yml`:

```yaml
tunnel: <your-tunnel-id>
credentials-file: ~/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: sms-webhook.example.com
    service: http://localhost:18789
  - service: http_status:404
```

### Important: Remote vs Local Config

Cloudflare Tunnels can be configured both locally (`config.yml`) and remotely (via the Cloudflare dashboard or API). **Remote configuration takes precedence over local configuration.** If your tunnel isn't routing correctly, check the remote config:

```bash
# Check remote tunnel config
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for rule in data['result']['config']['ingress']:
    print(f\"{rule.get('hostname', 'catch-all')} -> {rule['service']}\")
"

# Update remote tunnel config to point to OpenClaw
CURRENT=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations")

UPDATED=$(echo "$CURRENT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
cfg = data['result']['config']
for rule in cfg['ingress']:
    if rule.get('hostname') == 'sms-webhook.example.com':
        rule['service'] = 'http://localhost:18789'
print(json.dumps({'config': cfg}))
")

curl -s -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$UPDATED" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations"
```

## Troubleshooting

### Webhooks not arriving

1. **Check if the gateway is reachable** — `curl https://your-domain.com/sms-gateway/webhook` should not return a 502 or connection error. A `405 Method Not Allowed` is actually good — it means the route is registered but you need to POST.

2. **Check OpenClaw logs** — `openclaw logs | grep sms-gateway` should show webhook registration on startup and hits when webhooks arrive.

3. **Verify the tunnel** — if using Cloudflare Tunnel, make sure the remote config points to the correct port:
   ```bash
   curl -s https://your-domain.com/
   ```
   This should return the OpenClaw Control UI HTML, not a 502 or an Express error page.

4. **Check webhook registration** — list your registered webhooks:
   ```bash
   curl -u 'USER:PASS' https://api.sms-gate.app/3rdparty/v1/webhooks
   ```

5. **Test with curl** — send a fake webhook to confirm the pipeline works:
   ```bash
   curl -X POST -H 'Content-Type: application/json' \
     -d '{"event":"sms:received","payload":{"sender":"+15551234567","message":"test"}}' \
     http://localhost:18789/sms-gateway/webhook
   ```
   You should get `{"ok":true,"received":"..."}`.

### RCS / Chat Features Interference

**This is a critical gotcha.** If RCS (Rich Communication Services) or "Chat features" is enabled on the Android phone running SMS Gateway, **inbound messages received via RCS will not trigger SMS webhooks**. The SMS Gateway app only intercepts actual SMS messages, not RCS messages.

**Fix:** Disable RCS / Chat features in your Android messaging app settings:
- Open your default messaging app (e.g., Google Messages)
- Go to Settings → Chat features (or RCS)
- Turn off "Enable chat features"

This forces all conversations back to SMS, which the gateway app can intercept and forward via webhook.

### Agent replies not sending

1. **Check credentials** — make sure your cloud/local username and password are correct:
   ```bash
   curl -u 'USER:PASS' https://api.sms-gate.app/3rdparty/v1/message?limit=1
   ```
   A 401 means bad credentials.

2. **Check mode** — if `mode` is `"cloud"` but you only configured `local` credentials (or vice versa), sends will fail.

3. **Check the phone** — the Android phone needs to be on, have cell service, and have the SMS Gateway app running in the foreground or with battery optimization disabled.

### 502 errors through the tunnel

This means cloudflared can reach Cloudflare, but can't connect to the local backend:

1. Verify OpenClaw gateway is running: `ss -tlnp | grep 18789`
2. Verify the tunnel points to the right port (see "Remote vs Local Config" above)
3. Restart cloudflared after config changes: `sudo systemctl restart cloudflared`

### Session/routing issues

- The plugin uses `normalizeE164` to standardize phone numbers. If a number arrives without a country code, normalization may fail. Check logs for the `normalized sender:` line.
- Sessions are per-agent. The default agent is `main`. The session key pattern is `agent:main:sms-gateway:user:<e164>`.

## Security Considerations

- **Never commit `openclaw.json` to a public repo** — it contains API credentials
- Use `dmPolicy: "allowlist"` and populate `allowFrom` with only trusted phone numbers
- Set `webhookSecret` and configure the SMS Gateway to include it as an `X-Webhook-Secret` header
- The cloud API credentials (`username`/`password`) grant full access to send SMS from your phone — keep them safe

## License

MIT
