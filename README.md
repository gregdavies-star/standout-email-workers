# Standout Email Workers

Standalone email automation workers for [Standout](https://standout.jobs). Each worker
lives in its own directory, reads from the production Supabase database (read-only), and
never touches the main Standout app codebase.

## Workers

### `abandonment-job-email/`

An hourly cron worker that re-engages free users who signed up but went quiet. It:

1. Finds free users (no active/trialing subscription) who registered **1+ hour ago** and
   have a parsed resume.
2. Picks the single **best untouched job match** for each from their existing match queue
   — highest `pct`, excluding the rank 0/1/2 jobs already shown in-app, and only jobs seen
   in the last 7 days.
3. Generates 3 specific "why you match" bullet points with Claude Haiku (with a graceful
   non-AI fallback).
4. Sends a transactional email via a Brevo template.

State is tracked **only** in a local `sent.json` file — the worker performs **zero writes
to Supabase**.

---

## Setup

```bash
git clone https://github.com/gregdavies-star/standout-email-workers.git
cd standout-email-workers/abandonment-job-email
npm install
cp .env.example .env   # then fill in the values
```

### Environment variables

| Variable               | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `SUPABASE_URL`         | Supabase project URL                                           |
| `SUPABASE_SERVICE_KEY` | Service role key (read access is all that's needed)            |
| `BREVO_API_KEY`        | Brevo API key                                                  |
| `BREVO_TEMPLATE_ID`    | ID of the Brevo transactional template (placeholder until made)|
| `ANTHROPIC_API_KEY`    | Anthropic key for match-pitch generation                       |
| `STANDOUT_APP_URL`     | Base URL for job/matches links (default `https://standout.jobs`)|
| `DRY_RUN`              | `true` (default) logs only; `false` sends live emails          |

> The Brevo template does not exist yet. Leave `BREVO_TEMPLATE_ID` as a placeholder while
> testing in dry-run mode — the worker fails with a clear error if a live send is attempted
> without it.

---

## Run locally (dry run)

Dry run is the default. It logs every email it *would* send, makes **no** Brevo calls, and
does **not** write to `sent.json`:

```bash
cd abandonment-job-email
DRY_RUN=true node index.js
```

You'll see lines like:

```
[DRY RUN] Would send to: jane@example.com — Job: Sales Associate at Instacart (rank 5, 88% match, Posted 2 days ago)
[DRY RUN] Brevo params: { ... }
[DRY RUN COMPLETE] Would have sent 3 emails (1 skipped).
```

To send for real locally, set `DRY_RUN=false` in `.env`.

---

## Deploy to Vercel

The repo is Vercel-ready. The cron schedule lives in [`vercel.json`](./vercel.json) and
runs hourly (`0 * * * *`), hitting the serverless handler at
`/api/abandonment-job-email`.

1. Import the repo into Vercel.
2. Add every variable from `.env.example` under **Project → Settings → Environment
   Variables**. Keep `DRY_RUN=true` for the first deploys.
3. Deploy. The cron will appear under **Project → Cron Jobs**.

### Flip to live sends

When you're confident in the dry-run output, set `DRY_RUN=false` in the Vercel
environment variables and redeploy.

> **Note on dedup state:** `sent.json` is local to the running instance and is gitignored.
> On Vercel's ephemeral filesystem it will not persist reliably across invocations, so it
> is suitable for local runs and early testing. The intended long-term migration is to
> track sends in the database via an `abandonment_email_sent_at` column on `profiles`,
> replacing the `sent-tracker.js` file logic with a Supabase read/write.

---

## Error handling

- **Supabase query fails** → log and abort the run.
- **Match-pitch generation fails** → fall back to 3 generic reasons from the role/intent
  labels (no AI call).
- **Brevo send fails for one user** → log, skip that user, continue. A single user never
  crashes the whole run.

## File layout

```
standout-email-workers/
├── abandonment-job-email/
│   ├── index.js          entry point / orchestrator + Vercel handler export
│   ├── queries.js        all Supabase reads
│   ├── brevo.js          Brevo send logic
│   ├── sent-tracker.js   local file-based dedup (no DB writes)
│   ├── match-reason.js   AI-generated match pitch with fallback
│   ├── .env.example
│   └── package.json
├── api/
│   └── abandonment-job-email.js   Vercel serverless route → worker
├── vercel.json           cron schedule
└── README.md
```
