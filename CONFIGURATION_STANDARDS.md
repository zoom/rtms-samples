# RTMS Samples Configuration Standards

This document outlines the standardized configuration patterns used across all RTMS sample repositories to ensure consistency and maintainability.

## Environment Variables

### Core Zoom Configuration
All repositories now use the following standardized environment variable names:

```bash
# Zoom OAuth App Credentials
ZOOM_CLIENT_ID=your_zoom_client_id
ZOOM_CLIENT_SECRET=your_zoom_client_secret

# Zoom Secret Token for webhook validation
ZOOM_SECRET_TOKEN=your_zoom_secret_token

# Webhook endpoint path (configurable)
WEBHOOK_PATH=/webhook

# Server configuration
PORT=3000
```

### Server-to-Server (S2S) Configuration
For repositories that support S2S authentication:

```bash
# S2S OAuth App Credentials
ZOOM_S2S_CLIENT_ID=your_s2s_client_id
ZOOM_S2S_CLIENT_SECRET=your_s2s_client_secret
ZOOM_ACCOUNT_ID=your_account_id
```

### Additional Service-Specific Variables
For repositories that integrate with external services:

```bash
# Meeting configuration (for Zoom Room samples)
ZOOM_MEETING_NUMBER=your_meeting_number
ZOOM_MEETING_PASSCODE=your_meeting_passcode

# External API Keys (as needed)
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=your_preferred_model
ANTHROPIC_API_KEY=your_anthropic_api_key
OPENAI_API_KEY=your_openai_api_key

# Cloud Storage (as needed)
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=your_aws_region
AZURE_STORAGE_CONNECTION_STRING=your_azure_connection_string
```

## Webhook Endpoints

### Standard Pattern
All repositories use a configurable webhook endpoint:

```javascript
// JavaScript/Node.js
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
app.post(WEBHOOK_PATH, webhookHandler);
```

```python
# Python
WEBHOOK_PATH = os.getenv("WEBHOOK_PATH", "/webhook")
@app.route(WEBHOOK_PATH, methods=['POST'])
def webhook():
    # handler code
```

```csharp
// C#/.NET
var webhookPath = Environment.GetEnvironmentVariable("WEBHOOK_PATH") ?? "/webhook";
app.MapPost(webhookPath, WebhookHandler);
```

### Default Behavior
- **Default path**: `/webhook`
- **Configurable**: Via `WEBHOOK_PATH` environment variable
- **HTTP Method**: POST
- **Content-Type**: `application/json`

## Authentication Signature Generation

### Standard Pattern
All repositories use consistent signature generation for RTMS authentication:

```javascript
// JavaScript/Node.js
function generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET) {
    const message = `${CLIENT_ID},${meetingUuid},${streamId}`;
    return crypto.createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
}
```

```python
# Python
def generate_signature(client_id, meeting_uuid, stream_id, client_secret):
    message = f"{client_id},{meeting_uuid},{stream_id}"
    signature = hmac.new(
        client_secret.encode('utf-8'),
        message.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return signature
```

## File Structure Standards

### Environment Files
- **Development**: `.env` (never committed)
- **Example**: `.env.example` (committed as template)
- **Documentation**: Environment variables documented in README.md

### Configuration Files
- **JavaScript**: `config.js` for centralized configuration loading
- **Validation**: Required environment variables are validated at startup
- **Error Handling**: Clear error messages for missing required variables

## Migration Guide

### From Old Pattern to New Pattern

#### Environment Variables
```bash
# OLD (inconsistent)
ZM_CLIENT_ID=...
ZM_CLIENT_SECRET=...

# NEW (standardized)
ZOOM_CLIENT_ID=...
ZOOM_CLIENT_SECRET=...
```

#### Webhook Endpoints
```javascript
// OLD (hardcoded)
app.post("/webhook", handler);

// NEW (configurable)
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
app.post(WEBHOOK_PATH, handler);
```

## Repository Status

### ✅ Standardized Repositories
- `rtms_api/manual_start_stop_using_rtms_api/`
- `rtms_api/python_manual_start_stop_rtms/`
- `boilerplate/working_sdk_zoom_room_screenshot/`
- All other repositories already follow the standard pattern

### 📋 Standard Compliance Checklist
- [x] Uses `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET`
- [x] Uses configurable `WEBHOOK_PATH` environment variable
- [x] Webhook endpoint defaults to `/webhook`
- [x] Signature generation follows standard pattern
- [x] Environment variables documented in README
- [x] Required variables validated at startup

## Benefits of Standardization

1. **Consistency**: Uniform configuration across all samples
2. **Maintainability**: Easier to update and maintain repositories
3. **Developer Experience**: Predictable patterns for developers
4. **Documentation**: Clearer documentation and examples
5. **Automation**: Easier to create automated setup scripts

## Future Considerations

- Consider creating a shared configuration library for common patterns
- Implement automated validation scripts for configuration standards
- Create templates for new repositories to ensure compliance
- Regular audits to maintain consistency as new samples are added
