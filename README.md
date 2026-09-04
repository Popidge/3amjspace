# 3AMJ.SPACE

A deliberately small, chronological message board for weird and playful AI
projects. The app uses Next.js on Vercel and Convex for data, file storage, and
server actions. Clerk manages user authentication.

## Local development

Requirements: Node.js 20 or newer and pnpm 10.

1. Install the packages:

   ```sh
   pnpm install --frozen-lockfile
   ```

2. Create a development application in Clerk.

3. Enable email addresses and passwords in the Clerk application.

4. Activate the Convex integration in Clerk.

5. Copy the Clerk publishable key and secret key to `.env.local`:

   ```sh
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   ```

6. Copy the Clerk Frontend API URL to the Convex development deployment:

   ```sh
   npx convex env set CLERK_JWT_ISSUER_DOMAIN 'https://your-instance.clerk.accounts.dev'
   ```

7. Set `OPENAI_API_KEY` in the Convex development deployment.

8. Start the backend and frontend in separate terminals:

   ```sh
   npx convex dev
   pnpm dev
   ```

`npx convex dev` writes the public Convex URLs to `.env.local`.

Run the launch checks locally with:

```sh
pnpm lint
pnpm build
npx convex dev --once
```

## Production on Vercel and Convex

The repository includes `vercel.json`, so every Vercel production build first
deploys the matching Convex functions and then builds Next.js against that
deployment.

### 1. Create the Clerk production instance

1. Open the existing Clerk application.
2. Use the instance selector to create a production instance.
3. Clone the development settings when Clerk offers that option.
4. Set the production application domain to `3amj.space`.
5. Confirm that email address and password sign-up, email verification, and the
   required sign-in fields match the development instance.
6. Activate the Convex integration again. Clerk does not copy integrations from
   development to production.
7. Add every DNS record shown on Clerk's **Domains** page at the domain's DNS
   provider. These records include Clerk's Frontend API and email records.
8. Copy the production Frontend API URL shown by the Convex integration. It
   should have the form `https://clerk.3amj.space`.
9. Copy the production publishable and secret keys. Production keys start with
   `pk_live_` and `sk_live_`.

Follow Clerk's [production deployment guide](https://clerk.com/docs/guides/development/deployment/production)
if its dashboard reports any incomplete production requirements.

### 2. Configure the Convex production deployment

Open the production deployment for the `3amjspace` project in the Convex
dashboard. It is separate from the development deployment and starts with an
empty database.

Set these environment variables on the production deployment:

- `OPENAI_API_KEY`: the key used for text and image content-safety checks.
- `CLERK_JWT_ISSUER_DOMAIN`: the exact production Frontend API URL copied from
  Clerk, without a trailing slash.

Generate a production deploy key in the Convex deployment settings. Give it the
`deployment:deploy` permission and keep it ready for Vercel.

### 3. Create and configure the Vercel project

1. Import `popidge/3amjspace` from GitHub.
2. Keep the repository root as the Vercel root directory.
3. Keep the detected framework as Next.js and the package manager as pnpm.
4. Add these variables to the **Production** environment only:
   - `CONVEX_DEPLOY_KEY`: the production deploy key from Convex.
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`: the Clerk `pk_live_` key.
   - `CLERK_SECRET_KEY`: the Clerk `sk_live_` key.
5. Do not set `NEXT_PUBLIC_CONVEX_URL`. The build command in `vercel.json`
   injects the URL for the Convex deployment selected by `CONVEX_DEPLOY_KEY`.
6. Deploy the project.

The first production deploy does not seed accounts, threads, projects, or
featured items.

### 4. Connect the public domain

1. Add `3amj.space` to the Vercel project.
2. Add `www.3amj.space` and redirect it to `3amj.space` if that is the preferred
   canonical address.
3. Add the DNS records that Vercel shows. Do not remove the separate Clerk DNS
   records.
4. Wait until both Vercel and Clerk show their domain and certificate checks as
   complete.
5. If Clerk generates a new publishable key after a domain change, replace
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in Vercel and redeploy.

### 5. Verify and bootstrap production

1. Open `https://3amj.space` in a private browser window.
2. Create the first production account and complete email verification.
3. Finish its 3AMJ.SPACE profile.
4. Create a safe test project with an image and link. Confirm that it stays
   hidden while moderation runs and appears after approval.
5. Add and edit a reply, then delete it.
6. Confirm that sign-out, sign-in, and the light, dark, and system theme options
   work.
7. Check the Vercel build logs and Convex production logs for errors.
8. Promote the first moderator as described below.

Do not reuse the Clerk production keys on `*.vercel.app` preview URLs. Clerk
recommends development keys for host-provided preview domains. Preview support
can be added later with development Clerk keys and a Convex preview deploy key;
Convex preview deployments use isolated databases.

## Bootstrap the first moderator

New accounts are always ordinary members. After the intended moderator signs up
and finishes profile setup, promote that exact email from an authenticated
operator terminal:

```sh
npx convex run --prod forum:setModeratorByEmail '{"email":"you@example.com","moderator":true}'
```

The function is internal and cannot be called from the web app. Pass
`"moderator":false` to remove moderator access.

## Required production configuration

| Location | Variable | Purpose |
| --- | --- | --- |
| Vercel | `CONVEX_DEPLOY_KEY` | Selects and deploys the production Convex backend during the build |
| Vercel | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Identifies the production Clerk instance in the browser |
| Vercel | `CLERK_SECRET_KEY` | Gives the Next.js server access to the production Clerk instance |
| Convex production | `OPENAI_API_KEY` | Text and project-image content-safety checks |
| Convex production | `CLERK_JWT_ISSUER_DOMAIN` | Lets Convex validate Clerk session tokens |

Do not put `CLERK_SECRET_KEY` in Convex. Do not put `OPENAI_API_KEY` in Vercel.
Keep all live keys out of `.env.local` unless production is being diagnosed
locally. The `NEXT_PUBLIC_` values are browser-visible by design.

## Production notes

- Content stays hidden while OpenAI moderation runs. Rejected content and images
  are redacted from storage; only the moderation record remains.
- A genuine moderation service failure leaves the post hidden and recoverable
  from the submitting browser's local draft.
- Project images are stored in Convex storage and limited to one image of 5 MB.
- There are no seeded production accounts, threads, projects, or featured items.
