# Creating an App in the Zoom Marketplace

## Steps

1. **Sign in**: Go to https://marketplace.zoom.us/ with your RTMS-enabled account

2. **Create App**: Develop → Build App → General App → User-Managed

3. **Configure Event Subscriptions**:
   - Features → Access → Enable Event Subscription
   - Add Events → Search "rtms" → Select RTMS endpoints

4. **Configure Scopes**:
   - Scopes → Add Scopes → Search "rtms"
   - Add scopes for both "Meetings" and "Rtms"

5. **Get Credentials**:
   - Client ID
   - Client Secret
   - Webhook verification token (Secret Token)

## Environment Variables

After setup, add these to your `.env` file:

```env
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
ZOOM_SECRET_TOKEN=your_webhook_secret_token
```
