# Max

Training log and coach for Beau's daily bench / squat / deadlift experiment.

- **Front end:** Vite + React + TypeScript, deployed on Vercel at max.beaustudio.com.
- **Back end:** Supabase (Postgres + auth + row-level security). Schema in `supabase/migrations`.
- **Sheet import:** `scripts/sheet_import.py` turned the Beau-Max and Mallen-Max day tabs into SQL.

## Run locally

```
npm install
npm run dev
```

The Supabase URL and publishable key default to the production project; override with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.

## Who sees what

- The coach account (beau@beaustudio.com) sees and edits everything and links lifters to accounts on the People tab.
- A lifter account sees and logs only its own lifter.
- Plans, exercises and equipment are readable by everyone signed in; only the coach changes them.
