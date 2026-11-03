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

Admin (API key + `x-admin-token`):

- `POST /api/tournaments`, `PATCH /api/tournaments/:id`, `DELETE /api/tournaments/:id`
- `GET /api/admin/registrations[?tournamentId=&status=]`
- `GET /api/admin/registrations/:id` (full team details)
- `PATCH /api/admin/registrations/:id` `{ status, rejectionReason }`
- `DELETE /api/admin/registrations/:id` (frees the slot)
- `GET /api/admin/applications`, `PATCH /api/admin/applications/:id`, `DELETE /api/admin/applications/:id`
- `PUT /api/recruitment`

## Migration notes

`npm run api:migrate -- --keep-array` copies the legacy arrays into the new
collection and leaves the arrays in place as a backup. Re-running is safe
(entries are matched by pass code, or by team name when a legacy entry has no
pass code). Once the data is verified, run `npm run api:migrate` without the
flag to unset the embedded arrays.
"# cuec-server" 
