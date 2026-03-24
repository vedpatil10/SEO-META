const { URL } = require('url');
const crypto = require('crypto');

let lastAnthropicRequestAt = 0;

function parseSpreadsheetId(sheetUrl) {
  const match = String(sheetUrl || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : '';
}

function parseGid(sheetUrl) {
  const raw = String(sheetUrl || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    const queryGid = url.searchParams.get('gid');
    if (queryGid) return queryGid;

    const hashMatch = (url.hash || '').match(/gid=([0-9]+)/);
    return hashMatch ? hashMatch[1] : '';
  } catch {
    const match = raw.match(/[?#&]gid=([0-9]+)/);
    return match ? match[1] : '';
  }
}

async function resolveSheetNameFromMetadata(spreadsheetId, gid, accessToken) {
  if (!gid) return null;

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Sheets metadata read failed with status ${response.status}: ${text}`);
  }

  const data = await response.json();
  const match = (data.sheets || []).find((sheet) => String(sheet.properties?.sheetId) === String(gid));
  return match?.properties?.title || null;
}

function parseCsv(csvText) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        value += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(value);
      value = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }

    value += char;
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map((header) => String(header || '').trim());
  return rows.slice(1).filter((values) => values.some((cell) => String(cell || '').trim() !== '')).map((values, index) => {
    const record = { row_number: index + 2 };
    headers.forEach((header, headerIndex) => {
      record[header] = values[headerIndex] ?? '';
    });
    return record;
  });
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows) {
  if (!rows.length) return '';

  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => set.add(key));
    return set;
  }, new Set()));

  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ];

  return lines.join('\n');
}

function escapeSheetName(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'`;
}

function columnIndexToLetter(index) {
  let current = index + 1;
  let result = '';
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function stripMarkdownJson(text) {
  return String(text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
}

function safeJsonParse(text, fallback) {
  try {
    const cleaned = stripMarkdownJson(text);
    const match = cleaned.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : cleaned);
  } catch {
    return fallback;
  }
}

function normalizeCountry(region) {
  return String(region || '').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCsvCandidates(spreadsheetId, sheetName, gid) {
  const urls = [];
  if (sheetName) {
    urls.push(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`);
  }
  if (gid) {
    urls.push(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`);
  }
  urls.push(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`);
  return urls;
}

function hasGoogleServiceAccount() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function getGoogleAccessToken() {
  const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
  const privateKey = String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!serviceEmail || !privateKey) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const unsignedJwt = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  const signature = signer.sign(privateKey, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const assertion = `${unsignedJwt}.${signature}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token request failed with status ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function fetchSheetRowsViaApi(spreadsheetId, sheetName, accessToken, gid) {
  const resolvedSheetName = sheetName || await resolveSheetNameFromMetadata(spreadsheetId, gid, accessToken) || 'Sheet1';
  const range = `${escapeSheetName(resolvedSheetName)}!A:ZZ`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Sheets read failed with status ${response.status}: ${text}`);
  }

  const data = await response.json();
  const values = data.values || [];
  if (!values.length) {
    return { rows: [], headers: [], resolvedSheetName };
  }

  const headers = values[0].map((header) => String(header || '').trim());
  const rows = values.slice(1).map((cells, index) => {
    const row = { row_number: index + 2 };
    headers.forEach((header, headerIndex) => {
      row[header] = cells[headerIndex] ?? '';
    });
    return row;
  }).filter((row) => Object.values(row).some((value) => String(value || '').trim() !== ''));

  return { rows, headers, resolvedSheetName };
}

async function writeRowsViaApi(spreadsheetId, sheetName, headers, rows, accessToken) {
  if (!rows.length) return { updatedRows: 0 };
  const requiredHeaders = ['Meta Title', 'Meta Description', 'Title Length', 'Status'];
  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
  if (missingHeaders.length) {
    throw new Error(`Target sheet is missing required output columns: ${missingHeaders.join(', ')}`);
  }

  const updates = [];
  for (const row of rows) {
    const rowNumber = Number(row.row_number);
    if (!rowNumber) continue;

    for (const header of requiredHeaders) {
      const columnIndex = headers.indexOf(header);
      const columnLetter = columnIndexToLetter(columnIndex);
      updates.push({
        range: `${escapeSheetName(sheetName)}!${columnLetter}${rowNumber}`,
        values: [[String(row[header] ?? '')]],
      });
    }
  }

  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: updates,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Sheets write failed with status ${response.status}: ${text}`);
  }

  return response.json();
}

async function fetchSheetRows(spreadsheetUrl, sheetName, googleAccessToken) {
  const spreadsheetId = parseSpreadsheetId(spreadsheetUrl);
  const gid = parseGid(spreadsheetUrl);

  if (!spreadsheetId) {
    throw new Error('Invalid Google Sheet URL.');
  }

  if (googleAccessToken) {
    const { rows, headers, resolvedSheetName } = await fetchSheetRowsViaApi(
      spreadsheetId,
      sheetName,
      googleAccessToken,
      gid
    );
    return {
      spreadsheetId,
      gid,
      csvUrl: null,
      rows,
      headers,
      resolvedSheetName,
      source: 'google-oauth',
    };
  }

  if (hasGoogleServiceAccount()) {
    const accessToken = await getGoogleAccessToken();
    const { rows, headers, resolvedSheetName } = await fetchSheetRowsViaApi(
      spreadsheetId,
      sheetName,
      accessToken,
      gid
    );
    return {
      spreadsheetId,
      gid,
      csvUrl: null,
      rows,
      headers,
      resolvedSheetName,
      source: 'google-api',
    };
  }

  const candidates = buildCsvCandidates(spreadsheetId, sheetName, gid);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate);
      if (!response.ok) {
        lastError = new Error(`Google Sheet request failed with status ${response.status}.`);
        continue;
      }

      const text = await response.text();
      if (!text || text.includes('<!DOCTYPE html')) {
        lastError = new Error('Sheet is not publicly readable from a direct export URL.');
        continue;
      }

      const rows = parseCsv(text);
      const headers = rows.length ? Object.keys(rows[0]).filter((header) => header !== 'row_number') : [];
      return {
        spreadsheetId,
        gid,
        csvUrl: candidate,
        rows,
        headers,
        resolvedSheetName: sheetName || null,
        source: 'csv-export',
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to fetch rows from Google Sheets.');
}

async function callAnthropic(apiKey, prompt, maxTokens) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  const minIntervalMs = Number(process.env.ANTHROPIC_MIN_INTERVAL_MS || 16000);
  const maxAttempts = Number(process.env.ANTHROPIC_MAX_RETRIES || 6);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const now = Date.now();
    const waitFor = Math.max(0, lastAnthropicRequestAt + minIntervalMs - now);
    if (waitFor > 0) {
      await sleep(waitFor);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    lastAnthropicRequestAt = Date.now();

    if (response.ok) {
      const data = await response.json();
      return data.content?.[0]?.text || '';
    }

    const text = await response.text();
    if (response.status !== 429 || attempt === maxAttempts) {
      throw new Error(`Anthropic request failed with status ${response.status}: ${text}`);
    }

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Math.max(30000, attempt * 20000);
    await sleep(Number.isFinite(retryAfterMs) ? retryAfterMs : 30000);
  }

  throw new Error('Anthropic request failed after retries.');
}

async function fetchSerpResults(keyword, region, serpApiKey) {
  const query = new URL('https://serpapi.com/search.json');
  query.searchParams.set('q', keyword);
  query.searchParams.set('gl', normalizeCountry(region) || 'us');
  query.searchParams.set('hl', 'en');
  query.searchParams.set('num', '10');
  query.searchParams.set('api_key', serpApiKey);

  const response = await fetch(query);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SerpAPI request failed with status ${response.status}: ${text}`);
  }

  return response.json();
}

async function fetchPageContent(pageUrl) {
  if (!pageUrl) return '';
  const jinaUrl = `https://r.jina.ai/${pageUrl.startsWith('http') ? pageUrl : `https://${pageUrl}`}`;
  const response = await fetch(jinaUrl, { headers: { Accept: 'text/plain' } });
  if (!response.ok) return '';
  return response.text();
}

async function analyzeSerp(keyword, region, serpResults, anthropicKey) {
  const top5 = (serpResults.organic_results || []).slice(0, 5).map((item) => ({
    title: item.title || '',
    description: item.snippet || '',
    url: item.link || '',
  }));

  const serpText = top5.map((item, index) => (
    `Result ${index + 1}:\nTitle: ${item.title}\nDescription: ${item.description}\nURL: ${item.url}`
  )).join('\n\n');

  const prompt = `Analyse these top 5 Google SERP results for the keyword "${keyword}" in region "${region}".

${serpText}

Extract and return ONLY valid JSON:
{
  "common_words": "most repeated words or phrases across titles and descriptions",
  "avg_title_length": "average character count of titles",
  "avg_desc_length": "average character count of descriptions",
  "ctas_used": "specific CTAs found",
  "value_props": "specific value propositions",
  "emotional_triggers": "emotional or trust words",
  "title_patterns": "common title structures",
  "location_signals": "location specific words used",
  "trust_signals": "trust indicators",
  "price_signals": "pricing mentions"
}`;

  const raw = await callAnthropic(anthropicKey, prompt, 350);
  const analysis = safeJsonParse(raw, {
    common_words: '',
    avg_title_length: '',
    avg_desc_length: '',
    ctas_used: '',
    value_props: '',
    emotional_triggers: '',
    title_patterns: '',
    location_signals: '',
    trust_signals: '',
    price_signals: '',
  });

  return { top5, serpText, analysis };
}

async function analyzePageContext(keyword, pageContent, anthropicKey) {
  const prompt = `Analyse this page content for the keyword "${keyword}" and return ONLY valid JSON:
{
  "main_topic": "what this page is mainly about in one sentence",
  "search_intent": "informational or transactional or navigational or commercial",
  "page_type": "homepage or service page or product page or blog or category page",
  "target_audience": "who this page is targeting"
}

PAGE CONTENT:
${String(pageContent || '').slice(0, 3000) || 'No content available'}
`;

  const raw = await callAnthropic(anthropicKey, prompt, 220);
  return safeJsonParse(raw, {
    main_topic: '',
    search_intent: 'transactional',
    page_type: 'service page',
    target_audience: '',
  });
}

function validateMeta(keyword, metaTitle, metaDescription, existingTitles) {
  const keywordLower = String(keyword || '').toLowerCase();
  const keywordWords = keywordLower.split(' ').filter((word) => word.length > 3);
  const titleLower = String(metaTitle || '').toLowerCase();
  const descLower = String(metaDescription || '').toLowerCase();

  const keywordInTitle = titleLower.includes(keywordLower) || keywordWords.every((word) => titleLower.includes(word));
  const keywordInDesc = descLower.includes(keywordLower) || keywordWords.every((word) => descLower.includes(word));
  const hasCta = /call|book|get|shop|find|discover|try|start|contact|enquire|visit|learn|explore|request|schedule|order|buy|check|see|compare|download|sign up|apply|join/i.test(metaDescription);
  const duplicateTitle = existingTitles.some((title) => String(title || '').trim().toLowerCase() === titleLower);

  const issues = [];
  if (!keywordInTitle) issues.push('Keyword missing from title');
  if (!keywordInDesc) issues.push('Keyword missing from description');
  if (metaTitle.length < 40) issues.push(`Title too short (${metaTitle.length})`);
  if (metaTitle.length > 63) issues.push(`Title too long (${metaTitle.length})`);
  if (metaDescription.length < 130) issues.push(`Description too short (${metaDescription.length})`);
  if (metaDescription.length > 165) issues.push(`Description too long (${metaDescription.length})`);
  if (!hasCta) issues.push('No CTA in description');
  if (duplicateTitle) issues.push('Duplicate title detected');

  return {
    keywordInTitle,
    keywordInDesc,
    titleLength: metaTitle.length,
    descLength: metaDescription.length,
    duplicateTitle,
    issues,
    status: issues.length ? `Warning: ${issues.join(' | ')}` : 'Pass',
  };
}

async function generateMetaForRow(row, existingTitles, keys) {
  const keyword = String(row['Target Keyword'] || '').trim();
  const pageUrl = String(row['Mapped URL'] || '').trim();
  const region = String(row['Target Region'] || '').trim();

  const pageContent = await fetchPageContent(pageUrl);
  const pageContext = await analyzePageContext(keyword, pageContent, keys.anthropicKey);
  const serpResults = await fetchSerpResults(keyword, region, keys.serpApiKey);
  const serp = await analyzeSerp(keyword, region, serpResults, keys.anthropicKey);

  const buildPrompt = (extraInstruction = '') => `You are an expert SEO copywriter specialising in high-converting meta tags.
Generate an SEO Meta Title and Meta Description for the following page.

KEYWORD: ${keyword}

PAGE CONTEXT:
- Main topic: ${pageContext.main_topic}
- Search intent: ${pageContext.search_intent}
- Page type: ${pageContext.page_type}
- Target audience: ${pageContext.target_audience}

SERP INTELLIGENCE:
- Common words or phrases: ${serp.analysis.common_words}
- CTAs being used: ${serp.analysis.ctas_used}
- Value propositions: ${serp.analysis.value_props}
- Emotional triggers: ${serp.analysis.emotional_triggers}
- Common title patterns: ${serp.analysis.title_patterns}
- Location signals: ${serp.analysis.location_signals}
- Trust signals: ${serp.analysis.trust_signals}
- Price signals: ${serp.analysis.price_signals}

TOP SERP RESULTS:
${serp.serpText}

PAGE CONTENT:
${String(pageContent || '').slice(0, 3500) || 'No page content available'}

EXISTING META TITLES TO AVOID:
${existingTitles.length ? existingTitles.join('\n') : 'None'}

INSTRUCTIONS:
- If page content is available, use specific details from it to make the meta unique.
- If page content is not available, use SERP intelligence alone.
- Meta Title must be 50 to 60 characters and include "${keyword}" near the start.
- Meta Description must be 140 to 155 characters, include "${keyword}", and end with a CTA.
- Both title and description must contain the exact keyword "${keyword}".
- Do not generate a meta title that is identical or very similar to any title listed in EXISTING META TITLES TO AVOID.
- If needed, change the angle, USP, or wording to keep the title unique.
- Return JSON only.
${extraInstruction ? `- Additional instruction: ${extraInstruction}` : ''}
- Return JSON only.

{"meta_title":"","meta_description":""}`;

  let lastResult = null;
  const maxGenerateAttempts = Number(process.env.META_MAX_REGENERATIONS || 3);

  for (let attempt = 1; attempt <= maxGenerateAttempts; attempt += 1) {
    const extraInstruction = attempt > 1
      ? `Previous attempt was not unique enough or failed validation. Generate a clearly different title from existing titles and from the previous attempt.`
      : '';

    const raw = await callAnthropic(keys.anthropicKey, buildPrompt(extraInstruction), 500);
    const generated = safeJsonParse(raw, { meta_title: '', meta_description: '' });
    const validation = validateMeta(keyword, generated.meta_title || '', generated.meta_description || '', existingTitles);

    lastResult = {
      ...row,
      'Meta Title': generated.meta_title || '',
      'Meta Description': generated.meta_description || '',
      'Title Length': validation.titleLength,
      Status: validation.status,
      'Content Source': pageContent ? `Fetched from ${pageUrl}` : 'Page fetch unavailable',
    };

    if (!validation.duplicateTitle && validation.issues.length === 0) {
      return lastResult;
    }

    if (!validation.duplicateTitle && attempt === maxGenerateAttempts) {
      return lastResult;
    }
  }

  return lastResult;
}

async function runSeoAgent({ spreadsheetUrl, sheetName, googleAccessToken, onProgress }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
  const serpApiKey = process.env.SERPAPI_KEY || '';

  if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY in environment.');
  if (!serpApiKey) throw new Error('Missing SERPAPI_KEY in environment.');

  const {
    rows,
    headers,
    spreadsheetId,
    csvUrl,
    source,
    resolvedSheetName,
  } = await fetchSheetRows(spreadsheetUrl, sheetName, googleAccessToken);
  const eligibleRows = rows
    .filter((row) => String(row['Target Keyword'] || '').trim() !== '')
    .filter((row) => String(row['Mapped URL'] || '').trim() !== '')
    .filter((row) => String(row['Target Region'] || '').trim() !== '')
    .filter((row) => String(row['Meta Title'] || '').trim() === '');

  const existingTitles = rows
    .map((row) => row['Meta Title'])
    .filter((title) => String(title || '').trim() !== '');

  if (onProgress) {
    onProgress({
      stage: 'processing',
      totalRows: rows.length,
      eligibleRows: eligibleRows.length,
      processedRows: 0,
      skippedRows: rows.length - eligibleRows.length,
      currentKeyword: null,
    });
  }

  const generatedRows = [];
  for (const [index, row] of eligibleRows.entries()) {
    if (onProgress) {
      onProgress({
        stage: 'processing',
        totalRows: rows.length,
        eligibleRows: eligibleRows.length,
        processedRows: index,
        skippedRows: rows.length - eligibleRows.length,
        currentKeyword: row['Target Keyword'] || '',
      });
    }

    const result = await generateMetaForRow(row, existingTitles, { anthropicKey, serpApiKey });
    generatedRows.push(result);
    existingTitles.push(result['Meta Title']);

    if (onProgress) {
      onProgress({
        stage: 'processing',
        totalRows: rows.length,
        eligibleRows: eligibleRows.length,
        processedRows: index + 1,
        skippedRows: rows.length - eligibleRows.length,
        currentKeyword: row['Target Keyword'] || '',
      });
    }
  }

  let sheetWrite = null;
  if (generatedRows.length && (source === 'google-api' || source === 'google-oauth')) {
    const accessToken = source === 'google-oauth' ? googleAccessToken : await getGoogleAccessToken();
    sheetWrite = await writeRowsViaApi(
      spreadsheetId,
      resolvedSheetName || sheetName || 'Sheet1',
      headers,
      generatedRows,
      accessToken
    );
  }

  return {
    ok: true,
    spreadsheetId,
    sheetName: resolvedSheetName || sheetName || 'Sheet1',
    csvUrl,
    source,
    totalRows: rows.length,
    processedRows: generatedRows.length,
    skippedRows: rows.length - generatedRows.length,
    wroteToSheet: source === 'google-api' || source === 'google-oauth',
    sheetWrite,
    results: generatedRows,
    outputCsv: toCsv(generatedRows),
  };
}

module.exports = {
  parseSpreadsheetId,
  runSeoAgent,
};
