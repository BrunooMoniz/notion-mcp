# Deploy runbook — Friend Account Portal

This portal ships **inside the existing notion-mcp server**. In production it is served from the VPS at the same origin as the API, so the session cookie is first-party and the Notion redirect URI matches. Cloudflare Pages is **deferred** (see "Why not Pages yet").

## Architecture (as deployed)

```
https://vps-1200754.tail30b723.ts.net/
├── /                     static portal front (portal/index.html)   ← replaces old /onboard landing
├── /app.html             signed-in dashboard
├── /portal/*             portal API (register, login, verify, me, sources, ical, granola, notion/connect, reindex)
├── /notion/callback      Notion OAuth callback (shared: standalone + portal flows)
├── /mcp, /oauth, /status, /health, /google/*   unchanged
```

One process (`pm2 notion-mcp`) serves all of it. The `brain-indexer` / `brain-classifier` / nightly cron are unchanged.

## Why not Cloudflare Pages yet

The session is a first-party cookie. For a Pages-hosted front (`*.pages.dev`) to share that cookie with the VPS API (`*.ts.net`), both must sit under **one registrable domain** (e.g. `portal.example.com` + `api.example.com`). The Cloudflare account currently has **no domain/zone**, so a Pages front + VPS API would be cross-site and browsers would drop the cookie. Until a domain exists, the VPS serving both at one origin is the correct, working setup. To move to Pages later: register a domain in Cloudflare, point one subdomain at Pages (front) and one at the VPS (API), set `PORTAL_SESSION_COOKIE_DOMAIN=.example.com` and `PORTAL_PAGES_ORIGIN=https://portal.example.com`, and deploy `portal/` to Pages with `window.PORTAL_API_BASE` set to the API origin.

## One-time: environment on the VPS

Add to the VPS `.env` (never commit). Most already exist; the **new** ones are the email vars.

| Var | Value | Notes |
|---|---|---|
| `NOTION_OAUTH_CLIENT_ID` | (Notion integration client id) | likely already set (standalone onboarding used it) |
| `NOTION_OAUTH_CLIENT_SECRET` | (the Notion secret) | likely already set; keep out of git |
| `RESEND_API_KEY` | (Resend key) | **new** — magic-link email |
| `PORTAL_EMAIL_FROM` | `noreply@<verified-domain>` | **new** — see Resend domain below |
| `SECRETS_KEY` | (existing 64-hex vault key) | already set (vault in use) |
| `BASE_URL` | `https://vps-1200754.tail30b723.ts.net` | already set |

Optional: `PORTAL_COOKIE_SECURE=1` only if login doesn't stick (forces the Secure flag; normally auto-detected from `X-Forwarded-Proto`). Leave `PORTAL_SESSION_COOKIE_DOMAIN` and `PORTAL_PAGES_ORIGIN` **unset** (same-origin deploy).

**Notion redirect URI**: no change needed. The portal reuses the already-registered `${BASE_URL}/notion/callback`.

**Resend sending domain**: the test sender `onboarding@resend.dev` only delivers to the Resend account owner's own email. To email real friends, verify a domain in Resend and set `PORTAL_EMAIL_FROM` to an address on it.

## Deploy steps (on the VPS)

```bash
cd <notion-mcp repo>
git fetch origin
git checkout feat/001-account-portal     # or: git pull origin main  (after merge)
npm install                               # no new runtime deps; safe
npm run migrate -- --dry                  # should list: pending 0007_account_portal.sql
npm run migrate                           # applies 0007 (invite_codes, magic_links, portal_sessions, account.email)
npm run build                             # tsc -> dist/  (static portal/ is served as-is, no build)
pm2 restart notion-mcp
pm2 logs notion-mcp --lines 30            # confirm clean boot
```

The `brain-indexer` cron is untouched. Per-account indexing (incl. friends' Granola+iCal) runs on the portal "Indexar agora" button (`POST /portal/reindex`) and at Notion connect.

## Mint the first invite

```bash
npm run make-invite -- --label "primeiro amigo"
# prints a single-use code once; deliver out-of-band
```

## Post-deploy verification (production)

```bash
BASE=https://vps-1200754.tail30b723.ts.net
curl -s -o /dev/null -w "home %{http_code}\n"   $BASE/            # 200 (portal front)
curl -s -o /dev/null -w "health %{http_code}\n" $BASE/health      # 200
curl -s -X POST $BASE/portal/register -H 'Content-Type: application/json' \
  -d '{"invite_code":"<code>","email":"brunoomoniz@gmail.com"}'   # {"ok":true} + email arrives
```

Then in a browser: open `$BASE/`, enter the invite + your email, click the emailed link → dashboard. Connect Notion (button), add an iCal link + Granola key, hit "Indexar agora", and after the run query `brain_search` with your per-account `acct_` bearer to confirm only your data returns.

## Rollback

`git checkout main && npm run build && pm2 restart notion-mcp`. Migration 0007 is additive (new tables + a nullable column) and safe to leave applied; nothing reads it on the old code path.
