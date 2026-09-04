# Privacy and cookie audit

Audit date: 2026-09-04

This is an engineering audit. The operator must get legal advice for the final policy and processing agreements.

## Scope

The audit covers the application code and these production services:

- Clerk authentication.
- Convex data, file storage, and server functions.
- Vercel hosting.
- OpenAI content moderation.

The application does not include advertising, analytics, engagement scoring, or visit tracking.

## Data inventory

| Data | Location | Purpose | Current control |
| --- | --- | --- | --- |
| Account ID, email, and optional name | Clerk and Convex | Authentication and account linking | Clerk account controls |
| Public profile and links | Convex | Member identity | Profile editor |
| Posts, replies, projects, and images | Convex | Public forum | Author edit and delete controls |
| Moderation status and categories | Convex | Content safety | Moderator access |
| Private member reports | Convex | Human moderation | Moderator-only queue |
| Session tokens | Clerk cookies | Authentication | Essential cookie lifecycle |
| Theme choice | Browser storage | User-selected appearance | Browser controls |
| Unfinished drafts | Browser IndexedDB | Local draft recovery | Removed after successful submission or with browser controls |
| Request and diagnostic logs | Vercel and service providers | Security and reliability | Provider retention controls |
| Public profile and post content for classification | OpenAI API | Pre-publication safety check | OpenAI API data controls |

## Findings and actions

### 1. Public notice was missing

Risk: Visitors could not find a clear description of data use or browser storage.

Action: The feature drop adds a permanent `/privacy` page and a link in the
header.

### 2. Clerk development telemetry was enabled

Clerk collects SDK telemetry when the application uses a development instance.

Action: The application now disables Clerk telemetry in `ClerkProvider`. The
documented deployment configuration also sets
`NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED=1`.

### 3. A cookie banner is not necessary for the current application

The application does not set optional advertising or analytics cookies. Clerk authentication cookies are necessary for signed-in functions.

The theme and draft stores support functions that the visitor requests. The application keeps these values in the browser.

Action: Do not add a consent banner. Reassess this decision before any analytics, embeds, or optional tracking code is enabled.

### 4. Moderation sends content to OpenAI

The moderation request can contain public profile data, posts, links, tags, image descriptions, and uploaded images.

OpenAI states that API data is not used for training by default. Default abuse-monitoring logs can remain for up to 30 days.

Action: The public notice now identifies this transfer and its purpose.

### 5. Hosting providers process operational data

Vercel and Convex can process request, function, storage, and diagnostic logs. The application does not copy these logs into another analytics system.

Action: Keep log output free of post bodies, email addresses, tokens, and uploaded file URLs.

### 6. Privacy requests need an operator channel

Action: Configure `privacy@3amj.space` before production release. Route it to the person responsible for privacy requests.

### 7. Retention rules need an operator review

Authors can delete posts and replies. The application also deletes related reports when the content is deleted.

Resolved reports are deleted from the application. The operator must define retention periods for moderation records, backups, and provider logs.

### 8. New external embeds require a new audit

An embedded video can disclose a visitor IP address and browser information to the video provider.

Action: Repeat the cookie and privacy review before the planned YouTube feature is enabled.

## Release checks

1. Configure and test `privacy@3amj.space`.
2. Review the current data processing agreements for Clerk, Convex, Vercel, and OpenAI.
3. Record the selected lawful bases and the legitimate-interest assessment.
4. Record retention periods for reports, moderation records, logs, and backups.
5. Make sure that the public notice matches the production service settings.

## Sources

- [Clerk cookie documentation](https://clerk.com/docs/guides/how-clerk-works/cookies)
- [OpenAI API data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)
- [Vercel runtime logs](https://vercel.com/docs/logs/runtime)
- [Convex log streams](https://docs.convex.dev/production/integrations/log-streams)
- [ICO privacy information guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-privacy-information-should-we-provide/)
