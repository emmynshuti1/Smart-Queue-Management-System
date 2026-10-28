# SQHS — Smart Queue Health System

Queue management for health centres: patient registration, unique daily tickets, priority and emergency
handling, counter calling, a self-service kiosk, a waiting-room display board with audio announcements,
SMS notifications, and analytics. Every figure comes from the database.

| Screen | URL | Who uses it |
|---|---|---|
| Staff console (dashboard, queue, analytics, SMS, settings) | `/` | Signed-in staff |
| Self-service kiosk | `/kiosk` | Patients (touchscreen at the entrance, no login) |
| Display board | `/display` | Waiting-room TV (no login, ticket numbers only) |

**Stack:** Node.js 22+ · Express · PostgreSQL · Socket.io · plain HTML/CSS/JS (no build step).

---

## Quick start

```bash
npm install
cp .env.example .env            # then set DB_PASSWORD and JWT_SECRET
npm run db:init                 # creates the database if missing and applies the schema (never drops data)
npm start                       # http://localhost:5000
```

On first start with an empty `users` table an `admin` account is created. Its password is
`ADMIN_INITIAL_PASSWORD` from `.env`, or, if that is blank, a random one printed once in the server log.
Change it under **Settings → My account**.

Development with auto-reload: `npm run dev`. Tests: `npm test` (see below).

### Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` *or* `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` | PostgreSQL connection. `DB_SSL=true` for hosted databases. |
| `JWT_SECRET` | ≥ 32 random characters. **Required** when `NODE_ENV=production`. |
| `ADMIN_INITIAL_PASSWORD` | Password for the first admin (only used when no users exist). |
| `DEFAULT_COUNTRY_CODE` | Converts local numbers such as `0788…` to `+250788…`. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | SMS delivery. Leave blank if you have no provider. |
| `FRONTEND_URL` | Only if the frontend is served from another origin. |

Facility details, queue rules, notification preferences, departments, counters and staff accounts are
managed in the app under **Settings**.

---

## How the queue works

**Tickets.** Each department has a ticket prefix (G, M, L…). Numbers are allocated atomically per department
per day (`G001`, `G002`, …), so concurrent registrations can't produce duplicates. Submitting the same patient twice
(same name, phone and department while the first ticket is still active) is rejected. Tickets still open at the end
of the day are closed automatically, so they never inflate the next day's queue or statistics.

**Lifecycle.**

```
waiting ──call──▶ called ──start──▶ in-progress ──complete──▶ done
   │                 │ ├─complete────────────────────────────▶ done
   │                 │ ├─absent──▶ no-show
   │                 │ ├─recall (up to “max calls”)
   │                 │ └─requeue──▶ waiting (keeps original place)
   └──cancel──▶ cancelled ◀──cancel── called
```

Any other transition is refused with HTTP 409. Every action is written to `queue_logs` with who did it,
when, and at which counter. You can see this as the ticket history in the console.

**Counters.** Staff pick the counter they are working at, then press **Call next**. A counter holds at most
one active ticket. Postgres enforces this with a unique partial index, and call-next uses row locks with
`FOR UPDATE SKIP LOCKED`, so two counters pressing *Call next* at the same moment always get different
patients.

**Ordering** (configurable under Settings → Queue rules):

1. Verified emergencies, when *Emergency handling* is “called first”. In **manual** mode, emergencies are
   never picked by *Call next*. They stay in a highlighted lane and clinicians call them explicitly.
2. Priority patients (elderly, disabled, pregnant), and self-declared kiosk emergencies awaiting triage.
3. Everyone else, in arrival order. An optional *fairness boost* lifts normal patients who have waited longer
   than N minutes up to the priority level.

Emergencies declared at the kiosk are **not trusted automatically**. They raise a "Triage required" alert on
the dashboard, and a nurse or doctor confirms or changes the priority. That decision is logged. Clinicians can always
call any waiting ticket directly ("Call" in the queue table). The system never overrides that decision.

**Wait estimates** use the patient's position, the number of open counters, how many of those are busy, and
the department's recent service times: the mean of the last 30 completed services in 14 days, blended with the
configured "typical service time" when history is thin. They are labelled as estimates.

---

## Privacy and access control

| Role | Can do |
|---|---|
| **Receptionist** | Register, cancel, send SMS, see full phone numbers. Can't see clinical notes or call patients. |
| **Nurse** | Register, call/serve, triage, cancel, send SMS. Phone numbers masked. |
| **Doctor** | Call/serve and triage. Phone numbers masked. |
| **Admin** | Everything, including settings, departments, counters and staff accounts. |

- The kiosk and display board use public endpoints that return **ticket numbers, counters and
  departments only**. They never return names, phone numbers, priority or notes. Tests check this.
- Real-time socket messages carry only "something changed" signals and ticket numbers. Screens then refetch
  through the authenticated API, which applies the role rules above.
- SMS texts contain no names or clinical details. The analytics CSV export is de-identified.
- Staff accounts are created by an admin. There is no public sign-up. Deactivating an account or
  changing its role takes effect on the next request, not when the token expires.
- Login and kiosk rate limiting, a strict Content-Security-Policy, `Cache-Control: no-store` on API
  responses, HTML-escaping of all user-entered text, and the server's own files are never served statically.

---

## SMS

SMS is delivered through Twilio's REST API **only when the three `TWILIO_*` variables hold real
credentials**. Without them every message is still recorded in the log with status
**"Not delivered — no provider"**, and the SMS page shows a warning banner. Nothing is ever shown as sent
unless the provider accepted it. Provider errors are stored and shown next to the message.

Automatic messages: ticket number on registration, "it's your turn" when called, and "almost your turn"
when the patient reaches a configurable position. Each can be switched off in Settings.

---

## Tests

```bash
npm test
```

The tests create and drop a temporary database (`sqhs_test_<pid>`) on the configured PostgreSQL server
and run the real HTTP API. They cover:

- **Queue reliability:** 50 concurrent registrations yield unique, gap-free numbers. Double submission
  creates one ticket. Parallel *Call next* from three counters never assigns a patient twice. A busy counter
  can't be handed a second patient. Invalid and conflicting transitions are rejected. The recall limit and
  requeue position hold. Priority and manual-emergency rules are followed. Triage is audited. End-of-day
  expiry works. The wait estimator is checked.
- **Privacy and permissions:** public endpoints leak no personal data. Staff endpoints require
  authentication, and forged tokens are rejected. There is no open staff sign-up. Role permissions and field
  masking are enforced. Source files aren't served. Deactivation is immediate. Unconfigured SMS is never
  marked sent.
- **Data accuracy:** dashboard and analytics figures equal independent SQL over the same records. The
  CSV export is de-identified.
- **Upgrade:** a database created by the original v1 `database.sql` migrates in place with its data intact.

---

## Deployment (e.g. Railway / Render)

1. Create a PostgreSQL database and set `DATABASE_URL` (plus `DB_SSL=true` if required).
2. Set `NODE_ENV=production`, `JWT_SECRET`, `ADMIN_INITIAL_PASSWORD`, and optionally the Twilio variables.
3. Start command: `npm start`. Migrations run automatically on boot and are safe to repeat.
4. Health check: `GET /health`.

Run one app instance. Real-time events and rate limits are kept in process memory. Running several instances
would need a Socket.io adapter, for example Redis.

## Project layout

```
server.js            entry point
src/app.js           HTTP server, security headers, static files, Socket.io, background jobs
src/routes.js        REST API
src/queue.js         ticket numbering, ordering, calling, state machine, wait estimates
src/stats.js         dashboard snapshot, analytics, CSV export
src/notify.js        SMS (Twilio REST) and notification triggers
src/auth.js          JWT, roles and permissions
src/schema.js        idempotent migrations and seed data
src/settings.js      validated, database-backed settings
public/              staff console, kiosk and display board
tests/               integration tests (node:test)
scripts/init-db.js   create database and apply schema
```
