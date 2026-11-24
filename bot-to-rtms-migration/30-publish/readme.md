# 30 Publish the app (Step 3)

There is no code in this folder. Publishing lets external Zoom accounts install your app. Reviews move fastest when every piece of your submission agrees: Marketplace settings, declared scopes, production OAuth behavior, public docs, reviewer test plan, screenshots, and listing copy. Whenever two of those disagree, review stalls.

**Contents**

- [3.1 Pick the distribution path](#31-pick-the-distribution-path)
- [3.2 Production infrastructure](#32-production-infrastructure)
- [3.3 Scopes](#33-scopes)
- [3.4 Public documentation](#34-public-documentation)
- [3.5 Review package](#35-review-package)
- [3.6 Final checks before submitting](#36-final-checks-before-submitting)
- [3.7 Working through review notes](#37-working-through-review-notes)
- [Common rejections and fixes](#common-rejections-and-fixes)
- [Adapting this sample](#adapting-this-sample)

## 3.1 Pick the distribution path

Choose Private, Beta, Unlisted, or Published first. That choice determines who can install the app and what security evidence Zoom requires.

- Zoom requires approval before users outside your account can add an RTMS app.
- Private and Beta apps skip the full public listing, but Beta sharing outside your account still requires Zoom approval of the authorization URL (typically 3-4 business days; initial 4-week renewable window) plus security evidence.
- Check Zoom's "Sharing Private and Beta apps" and "App review process" pages before deciding, because requirements change.

Test on a second Zoom account on a separate tenant before submitting. Submit as soon as webhooks, scopes, and any SDK paths work, not the week of launch: security documentation, test plans, screenshots, and listing copy take the longest.

Three review facts to plan around:

- Compliance review runs before security testing.
- Reviewers authorize the app with an external test account and verify that every declared scope is used.
- You need Developer Pack credits to get an RTMS app approved.

## 3.2 Production infrastructure

- Host production endpoints on a stable HTTPS domain you control. Enforce TLS 1.2 or 1.3 and refuse TLS 1.0 and 1.1 on every hop (viewer to CDN and CDN to origin).
- Never use a generated CDN hostname such as `d123example.cloudfront.net`. You cannot place Zoom's verification record under it or control its certificate policy. On CloudFront, configure a custom domain, an ACM certificate in `us-east-1`, `TLSv1.2_2021` or newer, and an HTTPS-only origin requiring TLS 1.2+.
- Verify every Marketplace domain with Zoom. DNS TXT verification is the most reliable. If using a verification file, serve it at the exact path with no redirect, no auth wall, and no SPA rewrite.
- Production OAuth must use the production Client ID and registered production redirect URI.

## 3.3 Scopes

Build a table listing every scope, the product feature that uses it, and the reviewer test step that exercises it. Drop any scope missing either column. Prefer granular scopes, request admin scopes only when strictly needed, and expect any later scope or event change to trigger re-review.

## 3.4 Public documentation

Host documentation on a domain you control and verify it opens in a signed-out browser. Cover four topics:

- **Add:** prerequisites, who can install, OAuth steps, and what success looks like.
- **Use:** core workflows, what each scope does, admin enablement, and host approval.
- **Troubleshoot:** map symptoms to causes, starting with `rtms.request_status`.
- **Remove:** how to uninstall, token deletion, data retention and deletion requests, effect on scheduled jobs, and how to reconnect later.

State plainly that Zoom displays the app in the active-app indicator, that admin and host approval apply, and what you store. Template to adapt:

> This app uses Zoom Realtime Media Streams. It does not join as a participant. While active, Zoom shows it in the meeting's active-app indicator. Your Zoom admin must enable RTMS and this app, and the host may be asked to approve. It receives `<media>` and keeps `<artifacts>` for `<retention>`. Contact `<contact>` to request deletion.

## 3.5 Review package

| Item | Requirements |
|---|---|
| Reviewer test plan | Numbered steps covering initial state, install, each start path, host approval, one test per scope, stop, removal, and reinstall |
| Reviewer accounts | A host account and an app-user account with dummy data and a working 2FA path. Put credentials only in private reviewer fields, never in public docs or replies |
| Screenshots | Current branding, production-like URLs, zero tokens or personal data. Show the working feature, not only a consent modal |
| Security evidence | Current and reachable documents for your path: SDLC, SAST, DAST, privacy policy, and TLS proof |
| Architecture statement | Hosted service, no participant tile, no desktop installer (unless you ship one) |

Have someone who did not build the app run the entire test plan from a clean browser and machine, and fix every snag before submitting.

## 3.6 Final checks before submitting

Probe your public webhook URL the way Zoom validates it (with `ZOOM_SECRET_TOKEN` in `.env`):

```bash
npm run live:check -- --public-url https://app.acme.io/webhook
```

This sends Zoom's `endpoint.url_validation` challenge and confirms your endpoint answers with the matching HMAC. Then verify by hand:

- Distribution path selected and its evidence requirements met.
- RTMS active on the test accounts with a concurrency limit configured.
- Every Marketplace domain passes Zoom ownership verification.
- An external TLS scanner confirms TLS 1.0 and 1.1 are refused on every hop (your local OpenSSL may hide old-TLS support by refusing it client-side).
- Production OAuth uses the production Client ID and registered production redirect URI.
- Public docs cover add, use, troubleshoot, and remove, and load while signed out.
- Listing and docs disclose the active-app indicator and admin/host approval requirements.
- Reviewer accounts work with dummy data, clear 2FA, and live in the private credential fields.
- A teammate ran the full test plan on a clean browser and machine.
- Screenshots show the real workflow with no tokens or personal data.
- Security evidence (SDLC, SAST, DAST, privacy policy, TLS proof) is current and reachable.
- Every active reviewer note and reply has been re-read before submission.

## 3.7 Working through review notes

1. Read every active reviewer note and its full reply thread.
2. Fix the underlying configuration, document, or environment. Replying alone fixes nothing.
3. Verify the fix yourself.
4. Reply with what changed, the exact URL or field to check, and the expected result.
5. Re-read the note before resubmitting, and do not assume it is resolved until the reviewer marks it resolved.

## Common rejections and fixes

| Rejection | Fix |
|---|---|
| Missing removal or user-impact docs | Add the Remove section (3.4) |
| Docs unreachable | Test every link signed out |
| Reviewer cannot complete OAuth | Rehearse every step on a clean machine |
| Test account blocked by 2FA | Provide a working 2FA path in private reviewer notes |
| Development credentials in production | Verify production Client ID and redirect URI |
| Unused scopes | Remove them, or add a feature and a test step |
| Screenshots from another app | Capture the submitted integration |
| Old TLS still accepted | Enforce TLS 1.2+ on both CDN and origin |
| Claiming a fix without proof | Name the exact field, URL, and expected output |

## Adapting this sample

Keep your reviewer-facing evidence in this folder (test plan, security summaries, listing copy). When review returns a note, update your live configuration first and then the copy here so they stay in sync.

---

## Elsewhere in the guide

Start from the [overview](../readme.md).

- [00 Design](../00-design/readme.md) - Production architecture, failover drills, media choices, observability, webhook SLO
- [10 Integration Advisor](../10-integration-advisor/readme.md) - Step 1: what changes, starter samples, gap checker
- [20 Configure](../20-configure/readme.md) - Step 2: Marketplace manifest, scopes, events, credentials
- [40 Prepare](../40-prepare/readme.md) - Step 4: admin enablement, host approval, consent, status codes
- [50 Start and Approval](../50-start-and-approval/readme.md) - Step 5: webhook intake, claims, tenant gate, OAuth
- [60 Stream Lifecycle Client](../60-stream-lifecycle-client/readme.md) - Step 6: signaling, media, keep-alives, reconnect, manifests
- [61 Media and Participants](../61-media-and-participants/readme.md) - Step 6: participant registry, camera selector, media profiles
- [70 Reporting Dashboard](../70-reporting-dashboard/readme.md) - Step 7: dashboard, alerts, event contract, rollout
