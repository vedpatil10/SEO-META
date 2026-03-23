const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { runSeoAgent } = require('./lib/seo-agent');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
];

const sessions = new Map();
const jobs = new Map();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function createJob() {
  const id = crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  const job = {
    id,
    status: 'queued',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    progress: {
      stage: 'queued',
      totalRows: 0,
      eligibleRows: 0,
      processedRows: 0,
      skippedRows: 0,
      currentKeyword: null,
    },
    result: null,
    error: null,
  };
  jobs.set(id, job);
  return job;
}

function getJobPayload(job) {
  return {
    ok: !job.error,
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    progress: job.progress,
    result: job.result,
    error: job.error,
  };
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function parseSpreadsheetId(sheetUrl) {
  const match = String(sheetUrl || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : '';
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    })
  );
}

function createSession(res, existingSessionId) {
  const sessionId = existingSessionId || crypto.randomBytes(24).toString('hex');
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {});
  }

  res.setHeader('Set-Cookie', `seo_meta_session=${sessionId}; HttpOnly; Path=/; SameSite=Lax`);
  return { id: sessionId, data: sessions.get(sessionId) };
}

function getSession(req, res) {
  const cookies = parseCookies(req);
  const sessionId = cookies.seo_meta_session;
  if (sessionId && sessions.has(sessionId)) {
    return createSession(res, sessionId);
  }
  return createSession(res);
}

function buildGoogleAuthUrl(state) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCodeForToken(code) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google OAuth token exchange failed with status ${response.status}: ${text}`);
  }

  return response.json();
}

async function refreshGoogleAccessToken(refreshToken) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google OAuth refresh failed with status ${response.status}: ${text}`);
  }

  return response.json();
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google profile request failed with status ${response.status}: ${text}`);
  }

  return response.json();
}

async function getValidGoogleAccessToken(session) {
  if (!session.googleTokens) {
    throw new Error('Google account is not connected.');
  }

  const expiresAt = Number(session.googleTokens.expires_at || 0);
  if (session.googleTokens.access_token && Date.now() < expiresAt - 60_000) {
    return session.googleTokens.access_token;
  }

  if (!session.googleTokens.refresh_token) {
    throw new Error('Missing Google refresh token. Reconnect your Google account.');
  }

  const refreshed = await refreshGoogleAccessToken(session.googleTokens.refresh_token);
  session.googleTokens.access_token = refreshed.access_token;
  session.googleTokens.expires_at = Date.now() + Number(refreshed.expires_in || 3600) * 1000;
  return session.googleTokens.access_token;
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const session = getSession(req, res);

  if (req.method === 'GET' && reqUrl.pathname === '/') {
    sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname.startsWith('/public/')) {
    const relativePath = reqUrl.pathname.replace('/public/', '');
    sendFile(res, path.join(PUBLIC_DIR, relativePath));
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/auth/status') {
    sendJson(res, 200, {
      ok: true,
      connected: Boolean(session.data.googleProfile),
      profile: session.data.googleProfile || null,
      oauthConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    });
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/auth/logout') {
    session.data.googleProfile = null;
    session.data.googleTokens = null;
    sendJson(res, 200, { ok: true, connected: false });
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/auth/google/start') {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      sendJson(res, 500, { ok: false, error: 'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment.' });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    session.data.oauthState = state;
    redirect(res, buildGoogleAuthUrl(state));
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/auth/google/callback') {
    try {
      const code = reqUrl.searchParams.get('code') || '';
      const state = reqUrl.searchParams.get('state') || '';
      const error = reqUrl.searchParams.get('error') || '';

      if (error) {
        redirect(res, `/?auth_error=${encodeURIComponent(error)}`);
        return;
      }

      if (!code || !state || state !== session.data.oauthState) {
        redirect(res, '/?auth_error=invalid_oauth_state');
        return;
      }

      const tokenData = await exchangeCodeForToken(code);
      const accessToken = tokenData.access_token;
      const profile = await fetchGoogleProfile(accessToken);

      session.data.googleTokens = {
        access_token: accessToken,
        refresh_token: tokenData.refresh_token || (session.data.googleTokens && session.data.googleTokens.refresh_token) || '',
        expires_at: Date.now() + Number(tokenData.expires_in || 3600) * 1000,
      };
      session.data.googleProfile = {
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
      };
      session.data.oauthState = null;

      redirect(res, '/?auth=success');
    } catch (error) {
      redirect(res, `/?auth_error=${encodeURIComponent(error.message || 'oauth_failed')}`);
    }
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/run') {
    try {
      const body = await readBody(req);
      const spreadsheetUrl = String(body.spreadsheetUrl || '').trim();
      const sheetName = String(body.sheetName || '').trim();

      if (!spreadsheetUrl || !parseSpreadsheetId(spreadsheetUrl)) {
        sendJson(res, 400, {
          ok: false,
          error: 'Enter a valid Google Sheets URL.',
        });
        return;
      }

      let googleAccessToken = '';
      if (session.data.googleProfile) {
        googleAccessToken = await getValidGoogleAccessToken(session.data);
      }

      const job = createJob();
      job.status = 'running';
      job.progress.stage = 'starting';
      job.updatedAt = Date.now();

      runSeoAgent({
        spreadsheetUrl,
        sheetName,
        googleAccessToken,
        onProgress: (progress) => {
          job.progress = { ...job.progress, ...progress };
          job.updatedAt = Date.now();
        },
      }).then((result) => {
        job.status = 'completed';
        job.result = result;
        job.finishedAt = Date.now();
        job.updatedAt = job.finishedAt;
      }).catch((error) => {
        job.status = 'failed';
        job.error = error.message || 'Unexpected server error.';
        job.finishedAt = Date.now();
        job.updatedAt = job.finishedAt;
      });

      sendJson(res, 202, {
        ok: true,
        jobId: job.id,
        status: job.status,
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || 'Unexpected server error.',
      });
    }
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname.startsWith('/api/jobs/')) {
    const jobId = reqUrl.pathname.split('/').pop();
    const job = jobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { ok: false, error: 'Job not found.' });
      return;
    }

    sendJson(res, 200, getJobPayload(job));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`SEO Meta frontend running at http://localhost:${PORT}`);
});
