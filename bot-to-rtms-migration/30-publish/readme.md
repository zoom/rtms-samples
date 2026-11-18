# 30 Publish the app

Step 3 of 7. There is no code here. This step is review and evidence. The full instructions are in the root readme, section **Step 3**. The rules that matter:

- Keep every representation of the product consistent. The Marketplace configuration, the scopes, the production OAuth behavior, the docs, the test plan, the screenshots and the listing copy. If two of them disagree, the review stalls.
- Keep the reviewer test plan concrete: starting state, install, each start path, host approval, one test per scope, stop, removal, reinstall.

**Contents**

- [3.1 Pick the distribution path first](#31-pick-the-distribution-path-first) - Private, Beta, Unlisted or Published, and what each demands
- [3.2 Production infrastructure](#32-production-infrastructure) and [3.3 Scopes](#33-scopes) - HTTPS endpoints and the scope table reviewers check
- [3.4 Documentation](#34-documentation) - the public page, add use troubleshoot remove
- [3.5 The review package](#35-the-review-package) and [3.6 Final checks before you submit](#36-final-checks-before-you-submit)
- [3.7 Submit, then treat each note as a defect](#37-submit-then-treat-each-note-as-a-defect) - working the review thread
- [Common rejections and how to avoid them](#common-rejections-and-how-to-avoid-them) and [Adapting this sample](#adapting-this-sample)

---

# The guide, part three: the review

## Step 3. Publish the app

Publishing is what lets other accounts install your app. It is mostly evidence gathering, and the way to get through it quickly is to keep every representation of the product consistent:

- the Marketplace configuration
- the scopes
- the production OAuth behavior
- the docs, the test plan, the screenshots and the listing copy

If two of them disagree, the review stalls.

### 3.1 Pick the distribution path first

Private, Beta, Unlisted or Published. It decides who can install and what Zoom asks you to prove.

- Zoom's RTMS page: approval is required before users outside your account can add the app.
- The general review page: Private and Beta apps do not go through review, but a Beta app can be shared outside your account only after Zoom approves the authorization URL (3-4 business days, and the first sharing period is 4 weeks, renewable).
- Do not ask for Beta sharing unless you need external testers and can supply security evidence.
- Definitions and requirements change, so read Zoom's "Sharing Private and Beta apps" and "App review process" pages before you decide.

**Test outside your own account before you submit.** Use a second Zoom account on a different tenant, and a Beta authorization URL if you need outside testers. Submit as soon as webhooks, scopes and any SDK paths work, not at the rollout date:

- the technical design and security documentation take the longest
- compliance review happens before security testing
- reviewers authorize the app with a test account that simulates an external user, and check that each declared scope is used
- you also need Developer Pack credits to get an RTMS app approved

### 3.2 Production infrastructure

- Stable production URLs on a domain you control. HTTPS only. Zoom supports TLS 1.2 and above only. TLS 1.0 and 1.1 are not supported and must be refused.
- If a CDN or proxy sits in front, check both hops: viewer to CDN, and CDN to origin.
- Do not use a generated CDN hostname such as `d123example.cloudfront.net` as the production domain. You cannot add Zoom's verification record under it and you do not control its certificate settings. On CloudFront use a custom domain, an ACM certificate in `us-east-1`, a `TLSv1.2_2021` or newer policy, and an HTTPS-only origin allowing only TLS 1.2.
- Verify every Marketplace domain with Zoom. A DNS TXT record is the most reliable check. A verification file must be served at the exact path and content, with no redirect, no authentication and no single-page-app rewrite.
- Production OAuth uses the production Client ID and the registered production redirect URI.

### 3.3 Scopes

Make a table of every scope. Each one needs a product feature that uses it and a reviewer step that exercises it. Remove any scope that has neither. Prefer granular scopes, and use admin scopes only when the use case needs them. Expect a changed scope or event list to go through review again.

### 3.4 Documentation

Host it on a domain you control and open it signed out. Cover four things.

- **Add.** Prerequisites, who can install, the OAuth steps, what success looks like.
- **Use.** The main workflows, what each scope does, admin enablement and host approval.
- **Troubleshoot.** Map symptoms to causes, starting from `rtms.request_status`.
- **Remove.** How to uninstall, what happens to tokens, what you keep and for how long, how a customer asks for deletion, what happens to scheduled jobs, how to reconnect later.

Say plainly that Zoom shows the app in the active-app indicator, that admin and host approval apply, and what you do with the data. A sentence to adapt:

> This app uses Zoom Realtime Media Streams. It does not join as a participant. While it is active, Zoom shows it in the meeting's active-app indicator. Your Zoom admin must enable RTMS and this app, and the host may be asked to approve. It receives `<media>` and keeps `<artifacts>` for `<retention>`. You can ask us to delete them at `<contact>`.

### 3.5 The review package

| Item | Notes |
|---|---|
| Reviewer test plan | A numbered plan: starting state, install, each start path, host approval, one test per scope, stop, removal, reinstall |
| Reviewer accounts | A host and an app user. Dummy data only. A way through 2FA. Credentials go in the private reviewer fields, never in public docs or ordinary replies |
| Screenshots | Your integration, current branding, production-like URLs, no tokens or personal data. A consent screen alone is not evidence of a working product |
| Security evidence | Whatever your path requires: secure development lifecycle, SAST, DAST, privacy policy, TLS proof. Current and reachable |
| Architecture statement | A hosted service, no participant, no desktop installer unless you ship one |

Have someone who did not build the app run the whole plan from a clean browser and machine, and fix whatever they trip over.

### 3.6 Final checks before you submit

Check your public webhook URL the way Zoom does, with `ZOOM_SECRET_TOKEN` set in `.env`:

```bash
npm run live:check -- --public-url https://app.acme.io/webhook
```

It sends the same `endpoint.url_validation` challenge Zoom sends and checks that your endpoint answers with your secret token. Then confirm each of these by hand before you submit:

- The distribution path is chosen and you know its evidence requirements.
- RTMS is active on the test accounts and a concurrency limit is set.
- Every Marketplace domain passes Zoom's ownership verification.
- An external TLS scanner confirms TLS 1.0 and 1.1 are refused on every hop. Your own machine cannot prove this, because its OpenSSL may refuse old protocols by itself.
- Production OAuth uses the production Client ID and the registered production redirect URI.
- The docs cover add, use, troubleshoot and remove, and they open in a signed-out browser.
- The listing and docs say plainly that Zoom shows the active-app indicator and that admin and host approval apply.
- Reviewer credentials work, expose dummy data only and sit in the private credential fields. The reviewer can get past 2FA and any role requirement.
- Someone who did not build the app ran the whole test plan from a clean browser and machine.
- Screenshots show the submitted integration and contain no tokens or personal data.
- Security evidence is current and reachable (secure development lifecycle, SAST, DAST, privacy policy, TLS proof).
- You re-read every active reviewer note and reply right before you submit.

### 3.7 Submit, then treat each note as a defect

1. Read every active reviewer note and its whole reply thread.
2. Change the actual configuration, document or environment. Replying is not fixing.
3. Verify the change yourself.
4. Reply with what changed and where to check it. The field, the exact URL or steps, the expected result.
5. Re-read the note before you resubmit, and do not call it resolved until it says so.

### Common rejections and how to avoid them

| Rejection | Prevention |
|---|---|
| No removal or user-impact section in the docs | Write it (3.4) |
| Docs not reachable | Open them signed out |
| Reviewer cannot reproduce OAuth | Rehearse every literal command from a clean machine |
| Test account blocked by 2FA | Give the reviewer a working path |
| Development credentials in production | Check the Client ID and redirect URI before submitting |
| Scopes without a feature | Remove them, or add a feature and a test step |
| Screenshots of an unrelated app | Use the real workflow |
| TLS 1.2 supported but old TLS still accepted | Set the minimum on both hops |
| A fix claimed without evidence | Give the exact place to look |

---
## Adapting this sample

Store your reviewer-facing evidence in this folder as you produce it: the test plan, the security documents, the listing copy. When review comes back with a note, change the actual configuration first, then the copy here, so the two never drift.

---

## Elsewhere in the guide

Every part, one click away. The [overview](../readme.md) holds the map.

- [00 Design](../00-design/readme.md) - Production architecture: failure drills, media choices, observability, the webhook SLO
- [10 Integration Advisor](../10-integration-advisor/readme.md) - Step 1. What changes, which sample to start from, the gap-checker
- [20 Configure](../20-configure/readme.md) - Step 2. The Marketplace app: manifest, scopes, events, credentials
- [40 Prepare](../40-prepare/readme.md) - Step 4. Admin enablement, host approval, consent, the status codes
- [50 Start And Approval](../50-start-and-approval/readme.md) - Step 5. The webhook endpoint, deduplication, claims, the tenant gate, OAuth
- [60 Stream Lifecycle Client](../60-stream-lifecycle-client/readme.md) - Step 6. Signaling and media sockets, keep-alives, reconnect, generations
- [61 Media And Participants](../61-media-and-participants/readme.md) - Step 6. The participant registry, the camera selector, media profiles
- [70 Reporting Dashboard](../70-reporting-dashboard/readme.md) - Step 7. The dashboard, alerts, the event contract, the production checklist
- [The root readme](../readme.md) - the seven steps, the plan and licensing checks, the reuse table

