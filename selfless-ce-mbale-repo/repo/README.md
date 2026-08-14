# Selfless CE Mbale Tech Center

A one-page site for the Selfless CE Mbale Tech Center, built in the navy visual style of [selfless-ce.web.app](https://selfless-ce.web.app/).

## Contents
- Hero + mission
- Vision / Mission / Values (SELFLESS acrostic) / Goals
- Mbale center spotlight (Office Manager: Kevin Wangoda)
- Programs: CAP, MAP, TAA
- FAQ
- Gallery
- Contact

## Run locally
Just open `index.html` in a browser — no build step required.

## Deploy with GitHub Pages
1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Under "Build and deployment", set Source to `main` branch, `/ (root)` folder
4. Save — your site will be live at `https://<username>.github.io/<repo-name>/`

## AI Assistant Setup

The site includes a floating chat bubble (bottom-right) connected to an AI assistant.
Because API keys can't be safely stored in a public website's code, the chat widget
talks to a small backend (`worker.js`) that keeps your Anthropic API key secret.
This backend runs free on Cloudflare Workers.

### 1. Get an Anthropic API key
Sign up at [console.anthropic.com](https://console.anthropic.com), create an API key
under **Settings → API Keys**.

### 2. Deploy the Worker
```bash
npm install -g wrangler
wrangler login

# From this repo's folder:
wrangler deploy worker.js --name selfless-ce-assistant

# Set your API key as a secret (you'll be prompted to paste it):
wrangler secret put ANTHROPIC_API_KEY --name selfless-ce-assistant
```

Wrangler will print a URL like `https://selfless-ce-assistant.<your-subdomain>.workers.dev`.

### 3. Connect the widget to your Worker
Open `index.html`, find this line near the bottom (inside the `<script>` tag):

```js
const CHAT_ENDPOINT = "https://YOUR-WORKER-SUBDOMAIN.workers.dev";
```

Replace it with the URL from step 2, commit, and push. The chat bubble will now
answer visitor questions live.

### 4. (Recommended) Lock down CORS
In `worker.js`, change:
```js
const ALLOWED_ORIGIN = "*";
```
to your actual site URL, e.g. `"https://yourusername.github.io"`, so only your
site can call the assistant.

**Cost note:** Cloudflare Workers' free tier covers 100,000 requests/day. Anthropic
API usage is billed separately per token — check current pricing at
[anthropic.com/pricing](https://www.anthropic.com/pricing).

## Finance Tracker (Stipends & Tutor Payments)

`admin.html` and `portal.html` add a login-protected system for paying students/tutors
via **MTN Mobile Money** (automated) or **bank transfer** (logged manually), and letting
each person see their own payment history.

**⚠️ Security & Compliance — read before going live**
This handles real money and people's personal financial details (phone numbers, bank
accounts). Before using it with real disbursements:
- Get your own legal/compliance review — in Uganda this likely touches the
  **Data Protection and Privacy Act (2019)** and Bank of Uganda rules around payment
  service providers. A nonprofit disbursing stipends is usually fine, but confirm with
  a lawyer familiar with Ugandan fintech regulation.
- **Never** share your MTN MoMo API keys, subscription key, or JWT secret with anyone,
  including in chat, screenshots, or public repos. They only ever go into Wrangler secrets.
- Test everything in the MTN MoMo **sandbox** environment first (`MOMO_BASE_URL =
  https://sandbox.momodeveloper.mtn.com`, `X-Target-Environment = sandbox`) before
  switching to production.
- MTN requires your server's **IP to be whitelisted** for Disbursement API calls —
  contact your MTN MoMo account rep to whitelist your Cloudflare Worker's outbound IP
  (or use a static-IP proxy if needed).
- Consider a second admin approval step before large payouts (this build lets any
  admin trigger a payment solo — add a review step if you want more control).

### 1. Create the database
```bash
wrangler d1 create selfless_finance
```
Copy the `database_id` it prints into `wrangler.toml`.

Load the schema:
```bash
wrangler d1 execute selfless_finance --file=./schema.sql
```

### 2. Set secrets
```bash
wrangler secret put JWT_SECRET
# paste any long random string, e.g. output of: openssl rand -hex 32

wrangler secret put ANTHROPIC_API_KEY
# (only needed if you haven't already set this for the chat assistant)

wrangler secret put MOMO_DISBURSEMENT_API_USER
wrangler secret put MOMO_DISBURSEMENT_API_KEY
wrangler secret put MOMO_DISBURSEMENT_SUBSCRIPTION_KEY
```

Then add these as plain vars in `wrangler.toml` (not secret, but still don't commit
production values to a public repo — keep this repo private or use `wrangler.toml`
locally only):
```toml
[vars]
MOMO_BASE_URL = "https://sandbox.momodeveloper.mtn.com"   # switch to proxy.momoapi.mtn.com in production
MOMO_TARGET_ENVIRONMENT = "sandbox"                          # or "mtnuganda" in production
MOMO_CALLBACK_URL = "https://your-worker-subdomain.workers.dev/momo-callback"
```

### 3. Deploy
```bash
wrangler deploy worker.js --name selfless-ce-backend
```

### 4. Create your first admin account
Set a one-time bootstrap key, then call the bootstrap route once:
```bash
wrangler secret put BOOTSTRAP_KEY
# paste any random string, e.g. output of: openssl rand -hex 16

curl -X POST https://your-worker-subdomain.workers.dev/api/bootstrap-admin \
  -H "Content-Type: application/json" \
  -d '{"bootstrapKey":"THE_KEY_YOU_JUST_SET","name":"Your Name","email":"you@selfless-ce.org","password":"choose-a-strong-password"}'
```
It only works once (it refuses if an admin already exists). After this, log in at
`admin.html` with that email/password — and consider rotating `BOOTSTRAP_KEY` to
something else afterward for extra safety.

### 5. Connect the frontend pages
In both `admin.html` and `portal.html`, replace:
```js
const API = "https://YOUR-WORKER-SUBDOMAIN.workers.dev";
```
with your deployed Worker URL from step 3, then commit and push.

Your dashboards will be live at:
- `https://<username>.github.io/<repo-name>/admin.html`
- `https://<username>.github.io/<repo-name>/portal.html`


