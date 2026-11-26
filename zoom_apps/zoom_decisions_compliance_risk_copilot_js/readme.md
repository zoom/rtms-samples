# Compliance And Risk Copilot

A Zoom App that receives live Zoom Meeting transcripts through RTMS and uses the Zoom AI Services Decisions API to evaluate regulated conversations in real time.

The app evaluates **both** Agent disclosures/confirmations and Customer consent/questions/objections, tracks a persistent call-wide **Compliance Checklist** (`Identity`, `Consent`, `Fees`, `Risks`, `Alternatives`, `Understanding`), handles live RTMS transcript rewinds in place, and provides one-click **Audit Trail Export** (JSON & CSV). The app does not send messages or take external actions.

## Decision Contract

Zoom Decisions receives bounded recent transcript history with explicit `[Agent]` / `[Customer]` speaker role labels and returns:

- `choice`: conversation stage, compliance state, missing requirement, and next agent action.
- `predicate`: probability that the relevant consent is recorded.
- `score`: compliance risk from `Low` to `Critical`.

The suggested phrase is selected from application-owned text, so the agent action remains predictable and auditable.

## Key Features & Improvements

- **Agent + Customer Evaluation**: Both Agent turns (disclosures, confirmations) and Customer turns (consent, confusion, objections) receive compliance decisions and update the dashboard. Users identify as `Agent` or `Customer` and can click any speaker badge to toggle that speaker's role, syncing `[Agent]` / `[Customer]` labels into subsequent Zoom Decisions prompts.
- **Short Consent Turn Preservation**: Short utterances like `"Yes"`, `"No"`, `"I agree"`, or `"Correct"` are always recorded in `TranscriptRevisionStore` and evaluated rather than dropped.
- **In-Place Transcript Rewinds & Coalesced Calls**: RTMS transcript revisions (`isUpdate` / `sentenceId`) update existing turns in place, and rapid bursts coalesce pending Decisions API calls so only the latest state is evaluated next.
- **Persistent Compliance Checklist & Audit Export**: Tracks `Identity`, `Consent`, `Fees`, `Risks`, `Alternatives`, and `Understanding` across the full call and exports the turn history, checklist, and risk alerts as JSON or CSV.
- **Resilient Auth & Late-Join Replay**: Authorizes WebSocket clients via active RTMS connection match, HMAC token minted from verified `x-zoom-app-context` on `GET /`, optional `FRONTEND_WSS_AUTH_TOKEN`, or dev-only `ALLOW_PRE_RTMS_REGISTRATION=true`. Frontend auto-reconnects with exponential backoff and hydrates state from `session_snapshot`.

## Prerequisites

- Node.js 20 or newer.
- A Zoom Marketplace app with Zoom Apps and RTMS enabled.
- A Zoom AI Services API key with access to `zoom-decisions`.
- Live meeting transcription.
- A public HTTPS URL for the Zoom App and webhook.

## Configure

```bash
cp .env.example .env
```

Key environment variables:

| Variable | Purpose |
|---|---|
| `ZOOM_CLIENT_ID` | Zoom Marketplace app client ID |
| `ZOOM_CLIENT_SECRET` | Signs RTMS handshakes and decrypts `x-zoom-app-context` |
| `ZOOM_SECRET_TOKEN` | Verifies Zoom webhook signatures |
| `ZOOM_AI_SERVICES_API_KEY` | Server-side Zoom AI Services key |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | Optional explicit WebSocket URL; leave blank to auto-derive |
| `FRONTEND_WSS_AUTH_TOKEN` | Optional static token for frontend WS registration |
| `ALLOW_PRE_RTMS_REGISTRATION` | Set `true` for local dev without active RTMS or `x-zoom-app-context` |
| `ZOOM_DECISIONS_TIMEOUT_MS` | Timeout in ms for Zoom Decisions requests (default: `10000`) |
| `COMPLIANCE_CONTEXT` | Product, jurisdiction, script, or regulated conversation context |

## Run

```bash
npm install
npm test
npm run check
npm start
```

## Files

| File | Purpose |
|---|---|
| `index.js` | RTMS, webhook, `FrontendManager`, `FrontendWssManager`, late-join replay, and lifecycle handling |
| `complianceRiskAnalyzer.js` | Decision contract, `TranscriptRevisionStore`, coalesced Decisions API client, speaker roles, and persistent checklist |
| `wsAuth.js` | `x-zoom-app-context` decryption, HMAC WS tokens, and `authorizeRegistration` |
| `public/index.ejs` | Compliance copilot UI with role toggles, checklist, reconnect, and JSON/CSV audit export |
| `tests/complianceRiskAnalyzer.test.js` | Unit tests for normalization, short consent turns, rewinds, role labels, coalescing, checklist, and WS auth |

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
