# Selfless CE Mbale Tech Center

A site + backend for the Selfless CE Mbale Tech Center: a public one-page site, an
admin dashboard, and a student/tutor portal for duty tracking and attendance.

**Note:** the finance/stipend payment system (MTN MoMo disbursements) has been
removed as of this version. This is now a login + duty tracking + attendance system only.

## Contents

- `index.html` — public site (with an AI chat bubble)
- `admin.html` — admin dashboard: approve signups, manage people, assign/track duties, mark attendance
- `portal.html` — student/tutor portal: My Duties, My Attendance (installable as a phone app — see below)
- `worker.js` — Cloudflare Worker backend (auth, duties, attendance, chat)
- `schema.sql` — database schema for a fresh setup
- `migration_002_approved.sql` — adds account-approval support (only needed if you set up the DB before this feature existed)
- `migration_003_remove_payments.sql` — removes the old payments table/columns (only needed if you had the finance version running before)
- `manifest.json`, `service-worker.js`, `icons/` — make `portal.html` installable as an app

## Run locally
Just open `index.html` in a browser — no build step required.

## Deploy with GitHub Pages
1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Under "Build and deployment", set Source to `main` branch, `/ (root)` folder
4. Save — your site will be live at `https://<username>.github.io/<repo-name>/`

## Backend Setup (Cloudflare Worker + D1)

### 1. Create the database (skip if you already have one)
```bash
wrangler d1 create selfless_finance
```
Copy the `database_id` into `wrangler.toml`.

Load the schema:
```bash
wrangler d1 execute selfless_finance --file=./schema.sql --remote
```

**If you're upgrading from an earlier version of this project**, run whichever
migrations apply instead of/in addition to the schema:
```bash
wrangler d1 execute selfless_finance --file=./migration_002_approved.sql --remote
wrangler d1 execute selfless_finance --file=./migration_003_remove_payments.sql --remote
```
`migration_003` **permanently deletes** all payment records — there's no undo.

### 2. Set secrets
```bash
wrangler secret put JWT_SECRET
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put BOOTSTRAP_KEY
```

### 3. Deploy
```bash
wrangler deploy worker.js --name selfless-ce-backend
```

### 4. Create your first admin account
```bash
curl -X POST https://your-worker-subdomain.workers.dev/api/bootstrap-admin \
  -H "Content-Type: application/json" \
  -d '{"bootstrapKey":"THE_KEY_YOU_SET","name":"Your Name","email":"you@selfless-ce.org","password":"choose-a-strong-password"}'
```
Only works once (refuses if an admin already exists).

### 5. Connect the frontend
In `index.html`, `admin.html`, and `portal.html`, set:
```js
const API = "https://your-worker-subdomain.workers.dev"; // (index.html calls this CHAT_ENDPOINT)
```

## How People Get Access

- **Admin-created accounts**: in `admin.html`, under "Add Student or Tutor" — active immediately
- **Self-signup**: from `portal.html`'s login screen, click "Create an account" — goes into a
  **pending** queue until an admin approves it under "Pending Approvals" in `admin.html`
- **Password reset**: admin clicks "Reset Password" next to anyone in the People table,
  sets a new one, and shares it with them directly (no email step)

## Duty Tracking

- **Admin**: assign a duty (student, title, description, due date, priority), and browse/filter
  all duties by status or student in "Duty Overview"
- **Student**: "My Duties" shows a card list; tapping a duty opens details, lets them attach a
  proof-of-completion photo, and mark it complete
- Photos are stored as base64 text directly in the database, capped at ~1.5MB each. Fine for a
  small center; if it grows large, moving to **Cloudflare R2** (object storage) would scale better

## Attendance Tracking

- **Admin**: pick a student + date, mark Present / Late / Absent, optional note. Re-marking the
  same student/date updates the existing record instead of duplicating it
- **Student**: "My Attendance" shows their own history

## Turning the Student Portal into a Phone App (APK)

`portal.html` is set up as a **Progressive Web App (PWA)** — it has a manifest, icons, and a
service worker, so phones can install it like a real app. To get an actual `.apk` file:

### Option A — Add to Home Screen (no APK needed)
On Android, opening `portal.html` in Chrome shows an "Install app" / "Add to Home Screen"
prompt. This creates a real app icon and launches full-screen, no browser chrome. Simplest
option, works immediately once the site is live — no extra tools needed.

### Option B — Generate a real .apk with PWABuilder
1. Make sure your site is live (e.g. via GitHub Pages) at a public HTTPS URL
2. Go to **[pwabuilder.com](https://www.pwabuilder.com)**
3. Enter your portal URL, e.g. `https://yourusername.github.io/yourrepo/portal.html`
4. PWABuilder scores your PWA and lets you download an **Android package** — this produces
   a real, installable `.apk` (or `.aab` for Play Store submission)
5. Share the `.apk` directly with students (e.g. via WhatsApp) for manual install, or follow
   PWABuilder's guide to publish it on the Play Store

This is a standard, widely-used path for small teams to ship a real Android app without
maintaining native Android code.

## Security Notes

- Passwords are hashed with PBKDF2 (100,000 iterations) — never stored in plain text
- Sessions use signed JWTs, 12-hour expiry
- Only admins can create accounts directly or approve self-signups
- Consider tightening CORS in `worker.js` (`ALLOWED_ORIGIN`) to your exact site URL once
  everything is live, instead of `"*"`

## Duty Rota & Accountability Manager

A separate system from the one-off "Duties" tab — this handles **recurring weekly duties**
(cooking, cleaning, etc.) with fair rotation, a swap board, checklists, and ratings.

**Admin** (`admin.html` → "Duty Rota" tab):
- Create duty types (e.g. "Cooking", "Cleaning") with a checklist of steps each one requires
- Click "Generate Rota" for a given week + duty types — the system picks whichever *active*
  student has done the fewest rota duties so far (fair round-robin), one student per duty,
  never double-booking someone the same week
- View any week's assignments, and rate/check off completed ones
- See open swap requests at a glance

**Students & Tutors** (`portal.html`):
- **"Duty Rota"** — see your own assigned duties, request a swap if you can't do it (e.g. exam
  conflict) with an optional reason
- **"Swap Board"** — see everyone's open swap requests and claim one to take over
- Tutors additionally get a **"Rate Duties"** tab to check off checklist items and give a 1-5
  rating on any student's completed duty, center-wide (not just their own)

**Student status tags** — in the People table on `admin.html`, each student has a status
dropdown: Active / Probation / Internship. This also controls rota eligibility: only
students marked **Active** get pulled into "Generate Rota." Students on Probation or
Internship are automatically skipped, so you don't need to remember to exclude them manually.

## Announcements

Admins can post short announcements (title + message) from `admin.html`. They show up for
everyone — students, tutors, and admins — under the "Announcements" tab in `portal.html`
and, for admins, at the top of `admin.html`'s own Announcements tab. Newest 20 shown.

**One-time setup for this update:**
```bash
wrangler d1 execute selfless_finance --file=./migration_004_duty_rota.sql --remote
wrangler deploy worker.js --name selfless-ce-backend
```
