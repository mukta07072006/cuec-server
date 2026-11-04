# CUEC API server (Express + MongoDB)

The browser-facing backend. The Next.js app is now only the client; it talks to
this server over HTTP with an API key. It shares the project's `.env.local`.

```bash
npm run api        # http://localhost:4000
npm run api:migrate # move legacy tournament.registeredSquads[] into the new collection
```

## Layout

```
api-server/
  index.mjs                  app wiring, /health, graceful shutdown
  config.mjs                 env loading + fail-fast validation
  db.mjs                     mongoose models + serializers
  http.mjs                   auth, CORS, origin checks, rate limits, errors
  security.mjs               sanitizers, HMAC admin tokens, redaction
  email.mjs                  Resend receipts (optional)
  routes/tournaments.mjs     public reads + admin create/update/archive
  routes/registrations.mjs   public register/lookup + admin list/detail/status
  routes/recruitment.mjs     recruitment config + member applications
  routes/members.mjs         member directory, photo submission/review, CSV import, window
  routes/uploads.mjs         base64 image uploads to Cloudinary (admin)
  routes/bootstrap.mjs       public page bootstrap (tournaments + recruitment)
  routes/overview.mjs        admin console aggregate
  members.mjs                member data access + serializers
  memberModels.mjs           member + achievement + settings schemas
  memberCsv.mjs              CSV sheet parser used by the import
  cloudinary.mjs             signed Cloudinary uploads
  images.mjs                 image magic-byte + dimension validation
  scripts/migrate-registrations.mjs
```

## Data model change

Tournament registrations used to be an embedded array
(`tournament.registeredSquads[]`). They are now documents in the
`tournamentregistrations` collection:

| field | notes |
| --- | --- |
| `tournamentId` | `ObjectId` reference to the tournament (indexed) |
| `tournamentSlug` | denormalized for URL lookups |
| `passCode` | unique per tournament |
| `captainName`, `captainStudentId`, `captainEmail`, `captainDiscord`, `captainInGameId` | team contact |
| `rosterMembers[]` | role, full name, student ID, IGN, in-game ID |
| `status` | `Pending Check-In` / `Verified` / `Approved` / `Rejected` |
| `rejectionReason` | set when rejected |

Indexes: `{ tournamentId, passCode }` (unique), `{ tournamentId, createdAt }`,
`{ tournamentSlug, createdAt }`.

Slot accounting is atomic: registering claims a slot with
`$expr: { $lt: [slotsFilled, slotsTotal] }` + `$inc`, and the slot is released
if the insert fails or the admin removes the entry.

## Security model

| Layer | What it does |
| --- | --- |
| `x-api-key` | Public client key (`API_KEY`, shipped as `NEXT_PUBLIC_API_KEY`). Rejects unknown callers; it is an abuse filter, not a secret. |
| Origin check | Every `POST`/`PATCH`/`PUT`/`DELETE` must carry an allow-listed `Origin`/`Referer` (`ALLOWED_ORIGINS`), otherwise 403. |
| CORS | Only `ALLOWED_ORIGINS` may read responses in a browser. |
| `x-admin-token` | 5-minute HMAC token minted by `GET /api/backend-token` **only** for a Better Auth session with the `admin`/`superadmin` role. Signed with `ADMIN_TOKEN_SECRET`. |
| `x-service-key` | Optional server-to-server key (`SERVICE_API_KEY`) for scripts; bypasses origin checks. |
| Rate limits | 300 req/min per IP overall, 240/min on admin routes, 15 registrations/10 min, 10 applications/10 min. |
| Input hygiene | Length-capped sanitizers on every field, strict enums, 96 kB JSON cap, safe image URLs only. |
| Output hygiene | Public endpoints never return emails, student IDs, Discord handles or pass codes. |
| Errors | 5xx messages are generic in production; no stack traces or DB details. |

## Endpoints

Public (API key only):

- `GET /api/tournaments`, `GET /api/tournaments/:slugOrId`
- `POST /api/tournaments/:slug/register` → `{ registration, passCode, tournament }`
- `GET /api/tournaments/:slug/registrations` (redacted summary)
- `GET /api/tournaments/:slug/registrations/:id` (roster + in-game IDs, no PII)
- `GET /api/recruitment`, `POST /api/recruitment/apply`
- `GET /api/bootstrap` (tournaments + recruitment for the public site)
- `GET /api/members`, `GET /api/members/:publicId`
- `GET /api/members/window`, `GET /api/members/lookup?q=`
- `POST /api/members/photo` — `{ publicId, studentId, file: dataUrl }`

Admin (API key + `x-admin-token`):

- `POST /api/tournaments`, `PATCH /api/tournaments/:id`, `DELETE /api/tournaments/:id`
- `GET /api/admin/registrations[?tournamentId=&status=]`
- `GET /api/admin/registrations/:id` (full team details)
- `PATCH /api/admin/registrations/:id` `{ status, rejectionReason }`
- `DELETE /api/admin/registrations/:id` (frees the slot)
- `GET /api/admin/applications`, `PATCH /api/admin/applications/:id`, `DELETE /api/admin/applications/:id`
- `PUT /api/recruitment`
- `GET /api/admin/overview`
- `POST /api/uploads/image` — `{ file: dataUrl, folder }`
- `GET /api/admin/members`, `POST /api/admin/members/import`
- `GET|PATCH /api/admin/members/window`
- `PATCH /api/admin/members/:publicId/photo`

Member directory, imports, photo review and uploads require a **superadmin**
role in the admin token; tournament admin routes accept `admin` too. The role is
minted into the token by `/api/backend-token` from the Better Auth account, so a
browser cannot promote itself.

## Images

The browser sends images as base64 data URLs (`POST /api/uploads/image`,
`POST /api/members/photo`). The server sniffs the magic bytes, checks the
dimensions, then signs and performs the Cloudinary upload itself. Member photos
are normalised to a 600×600 face crop; banners keep their original framing.

## Migration notes

`npm run api:migrate -- --keep-array` copies the legacy arrays into the new
collection and leaves the arrays in place as a backup. Re-running is safe
(entries are matched by pass code, or by team name when a legacy entry has no
pass code). Once the data is verified, run `npm run api:migrate` without the
flag to unset the embedded arrays.

## Deploying the server

Railway (or Render/Fly/any VPS) is the right home for this process: it is a
long-lived Express server with a persistent MongoDB connection, an in-memory
rate limiter and 8 MB JSON bodies. Vercel Functions do not fit it well — see
below.

### Railway (recommended)

This folder ships `package.json` (deps + `start` script) and `railway.json`
(Nixpacks build, start command, health check, restart policy).

1. New Project → **Deploy from GitHub repo** → pick the server repo.
2. If the API sits inside a monorepo, set **Root Directory** to `api-server`.
3. Add the variables below, then deploy. Railway injects `PORT`; the server
   prefers `PORT` over `API_PORT`, so no extra configuration is needed.
4. Settings → Networking → **Generate Domain** (or attach `api.example.com`).

| Variable | Required | Notes |
| --- | --- | --- |
| `MONGODB_URI` | yes | Atlas connection string; allow Railway's IPs (`0.0.0.0/0`) in Atlas. |
| `MONGO_DB_NAME` | no | Defaults to `CUEC`. |
| `API_KEY` | yes | 16+ chars, must equal the site's `API_KEY` / `NEXT_PUBLIC_API_KEY`. |
| `ADMIN_TOKEN_SECRET` | yes | 32+ chars, identical on the API and the Next app. |
| `ALLOWED_ORIGINS` | yes | The deployed site origin, e.g. `https://cuec.club` (comma-separated for previews). |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | for uploads | Or `CLOUDINARY_UPLOAD_PRESET` for unsigned presets. |
| `MEMBER_VERIFY_SECRET` | no | Falls back to `BETTER_AUTH_SECRET`. |
| `RESEND_API_KEY`, `EMAIL_FROM`, `SITE_URL` | no | Email notifications. |

After the first deploy, point the Next app at it: `NEXT_PUBLIC_API_BASE_URL`
(browser) and `API_BASE_URL` (server components), both `https://api.example.com`.

### Render

Render runs the same `node index.mjs` with `PORT` injected, so no code change is
needed:

- **Root Directory:** `api-server` when the repo also holds the Next app;
  otherwise leave it blank.
- **Build Command:** `npm install` (nothing is compiled — do not use `npm ci`
  unless `package-lock.json` is committed).
- **Start Command:** `node index.mjs`.
- **Health Check Path:** `/api/ping`.
- **Environment:** set the variables in the table above in the dashboard. A
  committed `.env` is not deployed (and must not be), so a missing variable
  fails startup with `API server configuration error` naming exactly which one.
- **MongoDB Atlas:** Render's egress IPs are dynamic on the free plan, so add
  `0.0.0.0/0` under Atlas → Network Access, or the container exits on
  `MongoDB connection failed` after a brief restart loop.

If startup ends with `Application exited early` and no error line, the process
finished without listening — check that the start command is `node index.mjs`
from the directory that actually contains it. Free instances sleep after 15
minutes idle; a 5-minute ping also keeps them warm.

### Vercel

Not recommended for this server. A Next.js deployment on Vercel does not run a
second long-lived Node process; you would have to wrap Express in an
`api/index.js` function plus a `vercel.json` rewrite, and then live with:

- a **4.5 MB request/response body limit** (Functions), which rejects the ~8 MB
  base64 member photos before your code sees them;
- per-invocation cold starts and a fresh MongoDB connection each time;
- the in-memory rate limiter resetting between invocations.

If you must use Vercel, move photos to signed direct-to-Cloudinary uploads first
and shrink the body cap. Hosting the API on Railway/Render/Fly keeps today's code
unchanged.

### Keeping it alive

`GET /api/ping` (alias `/ping`) is a liveness probe: no database call, no API
key, `Cache-Control: no-store`. `/health` stays the readiness probe and reports
`database: "connected" | "disconnected"`.

Railway runs the container continuously, so the process does not sleep on paid
plans. Still point a free monitor at the ping URL every 5 minutes — UptimeRobot,
Better Stack, cron-job.org — to catch outages and to keep the container warm
right after a redeploy. Railway's own health check uses `/api/ping` too, so a
transient Mongo outage does not fail a deployment.
