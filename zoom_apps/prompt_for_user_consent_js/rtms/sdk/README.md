# Consent App RTMS SDK Receiver

This service runs the consent sample's RTMS SDK media receiver.

## Docker

Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/prompt_for_user_consent_js/rtms/sdk/Dockerfile -t rtms-rtms-sdk .
docker run --rm --env-file zoom_apps/prompt_for_user_consent_js/rtms/sdk/.env -p 3002:3002 rtms-rtms-sdk
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.
