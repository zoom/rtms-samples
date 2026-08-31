# Consent Zoom App Frontend

This project builds and serves the consent sample's Zoom App user interface.

## Docker

Its multi-stage Dockerfile compiles the React application and serves only the static output from an unprivileged Nginx runtime.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/prompt_for_user_consent_js/frontend/Dockerfile -t rtms-prompt_for_user_consent_js-frontend .
docker run --rm -p 8080:8080 rtms-prompt_for_user_consent_js-frontend
```

Run the build from the repository root. This image contains the compiled static frontend only; configure its backend URL at build time according to the frontend variables described above.
