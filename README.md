# SEO Meta Agent

This app now runs without n8n.

It does four things directly:

1. Reads rows from a Google Sheet URL.
2. Fetches page content from the mapped URL.
3. Pulls SERP data from SerpAPI and generates metadata with Anthropic.
4. Writes results back to the same Google Sheet when the user connects Google through OAuth, and also lets you download a CSV.

## Required Sheet Columns

- `Target Keyword`
- `Mapped URL`
- `Target Region`

Rows that already contain `Meta Title` are skipped.

## Google Sheets Modes

This app supports two modes:

1. OAuth mode
   Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`.
   The user connects their own Google account, then the app reads and writes that user's sheet through Google Sheets API.

2. Service account mode
   Optional fallback for owner-controlled sheets shared with a service account.

3. Public CSV fallback
   If API credentials are not set, the app tries direct Google Sheets CSV export.
   In that mode it can read public/exportable sheets and returns a downloadable CSV, but it cannot write back.

## Local Run

1. Put your real keys in `.env`.
2. For user-based Google access, also set:

```env
GOOGLE_CLIENT_ID=your_google_oauth_client_id_here
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret_here
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
```

3. Run:

```powershell
node server.js
```

4. Open `http://localhost:3000`.
5. Click `Connect Google`.
6. Log in with a test user allowed in your Google OAuth app.
7. Paste a Google Sheet URL.
8. The app will read and write the same sheet through the connected user's Google permission.

## Notes

- Keep `.env` out of Git. Only commit `.env.example`.
- The old n8n workflow JSON is no longer required for the app to run locally.
- The app processes all rows where `Target Keyword`, `Mapped URL`, and `Target Region` are filled and `Meta Title` is empty.
- For arbitrary private user sheets without manual sharing, OAuth mode is the correct path.
