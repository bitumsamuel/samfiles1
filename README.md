# Selfless CE Mbale Tech Center

A site + backend for the Selfless CE Mbale Tech Center: a public one-page site, an
admin dashboard, and a student/tutor portal for duty tracking and attendance.

**Note:** the finance/stipend payment system (MTN MoMo disbursements) has been
removed as of this version. This is now a login + duty tracking + attendance system only.

## Contents

- `index.html` — public site (with an AI chat bubble)
- `admin.html` — admin dashboard: approve signups, manage people, assign/track duties, mark attendance, duty rota, grades, notifications
- `portal.html` — student/tutor portal: My Duties (incl. rota), My Attendance, Grades, Alarms (installable as a phone app — see below)
- `worker.js` — Cloudflare Worker backend (auth, duties, attendance, rota, grades, alarms, notifications, chat)
- `schema.sql` — database schema for a fresh setup
- `migration_002_approved.sql` — adds account-approval support (only needed if you set up the DB before this feature existed)
- `migration_003_remove_payments.sql` — removes the old payments table/columns (only needed if you had the finance version running before)
- `migration_004_duty_rota.sql` — adds the Duty Rota system
- `migration_005_rota_upgrade.sql` — upgrades rota to daily assignments + photo review workflow
- `migration_006_features.sql` — adds Grades, Alarms, Notifications, profile photos, and archivable duty/rota history
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

## Grade & Progress Tracker

Tracks each student's courses with both a grade and a progress percentage.

**Admin/Tutor** (`admin.html` → "Grades" tab): pick a student, enter a course name, grade
(free text — e.g. "A", "88%", "Pass"), and progress % (0–100). Edit or delete any row from
the table below. Filter the table by student.

**Students & Tutors** (`portal.html` → "Grades" tab): read-only view of their own courses,
grade, and a visual progress bar.

## Student Alarms / Reminders

**Students & Tutors** (`portal.html` → "Alarms" tab): create a labeled reminder with a time
and which days of the week it repeats on (defaults to every day). Toggle on/off or delete
any alarm. While the portal is open in a browser tab and notifications are allowed, a
browser notification fires at the set time (falls back to a plain alert if notifications
aren't granted). This is a best-effort, in-app reminder — it can't fire once the browser tab
is fully closed, so it's a companion to (not a replacement for) a phone alarm for anything
truly time-critical, like a wake-up call.

## Review Notifications

When a student submits proof-of-completion for a rota duty, every admin and tutor gets an
in-app notification (bell icon, top-right of `admin.html`, with an unread badge). Clicking a
notification marks it read; "Mark all read" clears the badge in one click. Notifications
refresh automatically every 30 seconds while the dashboard is open.

## Duty Rota Weeks & "My Duties"

Multi-week rota blocks are now labeled "Week 1" through however many weeks were generated
(up to the "Number of Weeks" you set when generating), both in `admin.html`'s Duty Rota
table and in `portal.html`'s "My Duties" tab, which now shows a student's rota assignments
grouped by week alongside their one-off duties — no need to check a separate tab to see
everything assigned to you.

## Clearing Duty History

Both `admin.html`'s "Duties" tab and "Duty Rota" tab have a **"Clear Duty History"** button.
This **archives** (soft-hides) everything currently marked completed — it does not delete
anything from the database, so history can be recovered later if ever needed. It simply
keeps the working views focused on what's current.

## Profile Pictures

Students and tutors can tap their avatar (top-right of `portal.html`) to upload a profile
picture. It shows in their own header and in the People table on `admin.html`. Stored as
base64, same size cap (~1.5MB) as other photo uploads in this project.

**One-time setup for this update:**
```bash
wrangler d1 execute selfless_finance --file=./migration_006_features.sql --remote
wrangler deploy worker.js --name selfless-ce-backend
```

