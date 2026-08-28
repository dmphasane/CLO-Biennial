# NEDLO Stokvel Fund — Deployment Guide (Render + Cloudinary)

This turns the browser-only tool into a secure, multi-user, cloud-hosted application.

## Architecture
- **Frontend** (the HTML app) → served by the same Render web service (from `/public`)
- **Backend API** (Node/Express) → Render Web Service
- **Database** → Render PostgreSQL (stores members, entries, aliases, audit log)
- **File storage** → Cloudinary (logo, PDF exports, uploaded statements)
- **Auth** → JWT tokens, bcrypt-hashed passwords

---

## STEP 1 — Prepare the code repository

1. Put the `nedlo-server` folder into a Git repo (can be the same CLO-Biennial repo in a subfolder, or a new repo).
2. Copy your frontend into the server's `public` folder:
   - Create `nedlo-server/public/`
   - Copy `index.html`, `register.html`, `register-remote.html`, `logo.png` into `public/`
   - (The frontend must be updated to call the API — see STEP 5)
3. Commit and push to GitHub.

---

## STEP 2 — Create the PostgreSQL database on Render

1. Render Dashboard → **New** → **PostgreSQL**
2. Name: `nedlo-stokvel-db`, Region: closest to South Africa (e.g. Frankfurt), Plan: Free
3. Click **Create Database**
4. Once ready, copy the **Internal Database URL** (you'll use it for DATABASE_URL)

---

## STEP 3 — Create the Web Service on Render

**Option A — Blueprint (easiest):**
1. Render → **New** → **Blueprint**
2. Connect your GitHub repo → Render reads `render.yaml`
3. It creates the web service + database together
4. Fill in the `sync: false` env vars when prompted (see STEP 4)

**Option B — Manual:**
1. Render → **New** → **Web Service** → connect repo
2. Root Directory: `nedlo-server` (if in a subfolder)
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Plan: Free

---

## STEP 4 — Set Environment Variables

In the Web Service → **Environment** tab, add:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | (a long random string — 32+ chars) |
| `DATABASE_URL` | (the Internal Database URL from STEP 2) |
| `CLOUDINARY_CLOUD_NAME` | (from Cloudinary dashboard) |
| `CLOUDINARY_API_KEY` | (from Cloudinary dashboard) |
| `CLOUDINARY_API_SECRET` | (from Cloudinary dashboard) |
| `TREASURER_PASSWORD` | (choose a strong password) |
| `FINSEC_PASSWORD` | (choose a strong password) |
| `RECSEC_PASSWORD` | (choose a strong password) |
| `FRONTEND_URL` | your Render app URL (e.g. `https://nedlo-stokvel-api.onrender.com`) |

---

## STEP 5 — Initialise the database

After the first deploy succeeds:
1. Render → Web Service → **Shell** tab
2. Run: `npm run initdb`
3. This creates all tables and seeds the 3 user accounts with the passwords you set.

---

## STEP 6 — Get Cloudinary credentials

1. Log in to Cloudinary → **Dashboard**
2. Copy: **Cloud Name**, **API Key**, **API Secret**
3. Paste into the Render env vars (STEP 4)
4. Cloudinary is used for: storing the logo, saving exported PDF reports, and archiving uploaded bank statements.

---

## STEP 7 — Access the app

- Open `https://your-service.onrender.com/` → the management portal
- `https://your-service.onrender.com/register.html` → registration form
- Log in with the credentials you set in STEP 4

---

## Security notes
- Passwords are bcrypt-hashed, never stored in plain text.
- All API routes (except `/api/login` and `/api/register`) require a valid JWT token.
- Tokens expire after 12 hours.
- Auth endpoint is rate-limited (20 attempts / 15 min).
- Public registration is rate-limited (50 / hour).
- HTTPS is enforced automatically by Render.
- POPIA: member data lives in your private Render database, not in browsers.

## Free tier note
Render free web services sleep after 15 min of inactivity and take ~30s to wake on the next request. For always-on, upgrade to the Starter plan (~$7/month).
