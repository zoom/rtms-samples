# Consent App Backend

This service runs the consent sample's API, Redis session, and Socket.IO coordination layer.

## Docker

Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/prompt_for_user_consent_js/backend/Dockerfile -t rtms-prompt_for_user_consent_js-backend .
docker run --rm --env-file zoom_apps/prompt_for_user_consent_js/backend/.env -p 3000:3000 rtms-prompt_for_user_consent_js-backend
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.
