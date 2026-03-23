const form = document.getElementById('trigger-form');
const result = document.getElementById('result');
const submitButton = document.getElementById('submit-button');
const downloadButton = document.getElementById('download-button');
const connectGoogleButton = document.getElementById('connect-google');
const disconnectGoogleButton = document.getElementById('disconnect-google');
const authBadge = document.getElementById('auth-badge');
const progressPanel = document.getElementById('progress-panel');
const startedAtEl = document.getElementById('started-at');
const processedCountEl = document.getElementById('processed-count');
const remainingCountEl = document.getElementById('remaining-count');
const currentKeywordEl = document.getElementById('current-keyword');
let latestCsv = '';
let activePoll = null;

function setAuthUi(status) {
  if (!status.oauthConfigured) {
    authBadge.textContent = 'OAuth not configured';
    authBadge.className = 'badge muted-badge';
    connectGoogleButton.disabled = true;
    disconnectGoogleButton.classList.add('hidden');
    return;
  }

  if (status.connected) {
    authBadge.textContent = `Connected: ${status.profile?.email || 'Google account'}`;
    authBadge.className = 'badge success-badge';
    connectGoogleButton.classList.add('hidden');
    disconnectGoogleButton.classList.remove('hidden');
  } else {
    authBadge.textContent = 'Google not connected';
    authBadge.className = 'badge muted-badge';
    connectGoogleButton.classList.remove('hidden');
    connectGoogleButton.disabled = false;
    disconnectGoogleButton.classList.add('hidden');
  }
}

async function loadAuthStatus() {
  const response = await fetch('/api/auth/status');
  const status = await response.json();
  setAuthUi(status);
  return status;
}

function formatDateTime(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function updateProgress(job) {
  const progress = job.progress || {};
  const eligible = Number(progress.eligibleRows || 0);
  const processed = Number(progress.processedRows || 0);
  const remaining = Math.max(0, eligible - processed);

  progressPanel.classList.remove('hidden');
  startedAtEl.textContent = formatDateTime(job.startedAt);
  processedCountEl.textContent = `${processed} / ${eligible}`;
  remainingCountEl.textContent = String(remaining);
  currentKeywordEl.textContent = progress.currentKeyword || '-';
}

async function pollJob(jobId) {
  if (activePoll) clearInterval(activePoll);

  const fetchJob = async () => {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();

    if (!response.ok || job.ok === false) {
      result.textContent = JSON.stringify(job, null, 2);
      clearInterval(activePoll);
      activePoll = null;
      return;
    }

    updateProgress(job);

    if (job.status === 'completed') {
      clearInterval(activePoll);
      activePoll = null;

      const data = job.result || {};
      latestCsv = data.outputCsv || '';
      if (latestCsv) {
        downloadButton.classList.remove('hidden');
      }

      result.textContent = JSON.stringify({
        ok: data.ok,
        source: data.source,
        totalRows: data.totalRows,
        eligibleRows: job.progress?.eligibleRows,
        processedRows: data.processedRows,
        skippedRows: data.skippedRows,
        wroteToSheet: data.wroteToSheet,
        csvUrl: data.csvUrl,
        results: data.results,
      }, null, 2);
      return;
    }

    if (job.status === 'failed') {
      clearInterval(activePoll);
      activePoll = null;
      result.textContent = JSON.stringify({ ok: false, error: job.error }, null, 2);
    }
  };

  await fetchJob();
  activePoll = setInterval(fetchJob, 2000);
}

connectGoogleButton.addEventListener('click', () => {
  window.location.href = '/auth/google/start';
});

disconnectGoogleButton.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  await loadAuthStatus();
  result.textContent = 'Google disconnected.';
});

downloadButton.addEventListener('click', () => {
  if (!latestCsv) return;

  const blob = new Blob([latestCsv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'seo-meta-output.csv';
  link.click();
  URL.revokeObjectURL(url);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const authStatus = await loadAuthStatus();
  if (!authStatus.connected) {
    result.textContent = JSON.stringify({
      ok: false,
      error: 'Connect Google first so the app can access and update the sheet.',
    }, null, 2);
    return;
  }

  const formData = new FormData(form);
  const payload = {
    spreadsheetUrl: formData.get('spreadsheetUrl'),
    sheetName: formData.get('sheetName'),
  };

  submitButton.disabled = true;
  submitButton.textContent = 'Triggering...';
  downloadButton.classList.add('hidden');
  latestCsv = '';
  progressPanel.classList.remove('hidden');
  startedAtEl.textContent = formatDateTime(Date.now());
  processedCountEl.textContent = '0 / 0';
  remainingCountEl.textContent = '0';
  currentKeywordEl.textContent = '-';
  result.textContent = 'Reading sheet and generating metadata locally...';

  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok || data.ok === false) {
      result.textContent = JSON.stringify(data, null, 2);
      return;
    }
    await pollJob(data.jobId);
  } catch (error) {
    result.textContent = JSON.stringify(
      { ok: false, error: error.message || 'Unexpected client error.' },
      null,
      2
    );
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Trigger SEO Agent';
  }
});

window.addEventListener('load', async () => {
  await loadAuthStatus();

  const params = new URLSearchParams(window.location.search);
  const auth = params.get('auth');
  const authError = params.get('auth_error');

  if (auth === 'success') {
    result.textContent = 'Google connected. Now paste the sheet URL and run the agent.';
  } else if (authError) {
    result.textContent = JSON.stringify({ ok: false, error: authError }, null, 2);
  }

  if (auth || authError) {
    window.history.replaceState({}, '', '/');
  }
});
