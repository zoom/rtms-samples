# Compliance And Risk Copilot

A Zoom App that receives live Zoom Meeting transcripts through RTMS and uses the Zoom AI Services Decisions API to evaluate regulated conversations.

The app shows each transcript turn, the current compliance state, the most important missing item, the conversation stage, whether consent is recorded, a five-level compliance risk score, and up to three reviewed agent actions. The user identifies as agent or customer. The app does not send messages or take external actions.

## Decision Contract

Zoom Decisions receives the bounded recent transcript and returns:

- `choice`: conversation stage, compliance state, missing requirement, and next agent action.
- `predicate`: probability that the relevant consent is recorded.
- `score`: compliance risk from `Low` to `Critical`.

The suggested phrase is selected from application-owned text, so the agent action remains predictable and auditable.

## Architecture

```text
Zoom Meeting transcript
        |
        v
Zoom RTMS transcript socket
        |
        v
RTMSManager -> bounded per-stream history
        |
        v
Zoom AI Services Decisions API
        |
        v
meeting-scoped WebSocket -> compliance copilot
```

The backend does not call `zoomSdk.startRTMS()`. RTMS must already be started by the host, another Zoom App workflow, or an account-side process.

## Prerequisites

- Node.js 20 or newer.
- A Zoom Marketplace app with Zoom Apps and RTMS enabled.
- A Zoom AI Services API key with access to `zoom-decisions`.
- Live meeting transcription.
- A public HTTPS URL for the Zoom App and webhook.

## Get The Zoom AI Services API Key

1. Sign in to [Platform Studio](https://zoom.ai/).
2. Open **Credentials**.
3. Select **Create** beside **API Keys**.
4. Name the key, choose expiration and IP restrictions as required, and grant permission for the AI Services Decisions API.
5. Copy the key immediately and store it in the server-side `.env` as `ZOOM_AI_SERVICES_API_KEY`.

Do not embed this key in client-side code. The backend sends it as the `x-api-key` header.

## Configure

```bash
cp .env.example .env
```

Required values:

| Variable | Purpose |
|---|---|
| `ZOOM_CLIENT_ID` | Zoom Marketplace app client ID |
| `ZOOM_CLIENT_SECRET` | Signs RTMS signaling and media handshakes |
| `ZOOM_SECRET_TOKEN` | Verifies Zoom webhook signatures |
| `ZOOM_AI_SERVICES_API_KEY` | Server-side Zoom AI Services key |
| `PUBLIC_BASE_URL` | Public HTTPS origin |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | Public secure WebSocket URL ending in `/ws` |
| `COMPLIANCE_CONTEXT` | Product, jurisdiction, script, or regulated conversation context |

In Marketplace, enable the Zoom App surface, add the application domain and `https://appssdk.zoom.us`, enable RTMS, and subscribe `meeting.rtms_started` and `meeting.rtms_stopped`. Point the webhook to `https://YOUR_DOMAIN_HERE/webhook`.

## Run

```bash
npm install
npm test
npm run check
npm start
```

Open the app inside an active meeting after RTMS has started.

## Compliance Behavior

- Agent turns are retained in context and drive compliance decisions.
- Customer turns are displayed and used as evidence.
- Missing items are reduced to one priority so the agent receives one clear action.
- Risk is advisory; a human confirms the final compliance action.
- Conversation history is in memory and scoped to the RTMS stream.

Tune `COMPLIANCE_CONTEXT` for the applicable product and regulatory script. The sample is not legal advice.

## Files

| File | Purpose |
|---|---|
| `index.js` | RTMS, webhook, frontend WebSocket, and lifecycle handling |
| `complianceRiskAnalyzer.js` | Decision contract, Zoom Decisions client, history, and agent actions |
| `public/index.ejs` | Compliance copilot UI |
| `tests/complianceRiskAnalyzer.test.js` | Response normalization tests |

## Docker

Build from the repository root:

```bash
docker build \
  -f zoom_apps/zoom_decisions_compliance_risk_copilot_js/Dockerfile \
  -t rtms-compliance-risk-copilot .

docker run --rm \
  --env-file zoom_apps/zoom_decisions_compliance_risk_copilot_js/.env \
  -p 3000:3000 \
  rtms-compliance-risk-copilot
```
