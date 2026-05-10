// Nexus Learn 3D development server
// Run: node server.js
// Then open: http://localhost:3001/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const baseDir = path.resolve(__dirname);

loadEnvFile(path.join(baseDir, '.env'));

const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3001;
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GOOGLE_SEARCH_API_URL = 'https://customsearch.googleapis.com/customsearch/v1';
const DEFAULT_HF_IMAGE_MODEL = process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell';
const USERS_FILE = path.join(baseDir, 'users.json');
const SESSION_COOKIE = 'nexuslearn_session';
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.GEMINI_API_KEY || 'nexuslearn-dev-secret';
const RUNTIME_ENV =
  process.env.RENDER_SERVICE_NAME || process.env.RENDER || process.env.RENDER_EXTERNAL_URL ? 'RENDER' : 'LOCAL';
const RUNTIME_INSTANCE_ID = `${RUNTIME_ENV.toLowerCase()}-${process.pid}`;
let activePort = null;
let browserOpened = false;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4'
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (!key || process.env[key]) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function getRuntimeInfo() {
  return {
    environment: RUNTIME_ENV,
    instanceId: RUNTIME_INSTANCE_ID,
    port: activePort,
    tutorModel: DEFAULT_GEMINI_MODEL,
    geminiKeyLoaded: Boolean(process.env.GEMINI_API_KEY),
    googleSearchConfigured: Boolean(process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX),
    huggingFaceConfigured: Boolean(process.env.HF_TOKEN),
    renderService: process.env.RENDER_SERVICE_NAME || null,
    gitCommit: process.env.RENDER_GIT_COMMIT || null
  };
}

function buildCommonHeaders() {
  return {
    'Cache-Control': 'no-store',
    'X-Nexus-Environment': RUNTIME_ENV,
    'X-Nexus-Instance': RUNTIME_INSTANCE_ID,
    'X-Nexus-Port': String(activePort || ''),
    'X-Nexus-Tutor-Model': DEFAULT_GEMINI_MODEL
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...buildCommonHeaders()
  });
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || '';
  return cookieHeader.split(';').reduce((cookies, item) => {
    const [rawKey, ...rawValue] = item.trim().split('=');
    if (!rawKey) {
      return cookies;
    }
    cookies[rawKey] = decodeURIComponent(rawValue.join('='));
    return cookies;
  }, {});
}

function createSessionToken(email) {
  const payload = Buffer.from(
    JSON.stringify({
      email,
      issuedAt: Date.now()
    })
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes('.')) {
    return null;
  }

  const [payload, signature] = token.split('.');
  const expectedSignature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session && typeof session.email === 'string' ? session : null;
  } catch (error) {
    return null;
  }
}

function setSessionCookie(res, email) {
  const secure = process.env.NODE_ENV === 'production' ? 'Secure; ' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${createSessionToken(email)}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=2592000`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? 'Secure; ' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=0`);
}

function getUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function validatePassword(password, user) {
  if (!user || !user.salt || !user.passwordHash) {
    return false;
  }

  const hash = crypto.pbkdf2Sync(password, user.salt, 120000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

function getAuthenticatedUser(req) {
  const cookies = parseCookies(req);
  const session = verifySessionToken(cookies[SESSION_COOKIE]);
  if (!session) {
    return null;
  }

  const users = getUsers();
  return users.find((user) => user.email === session.email) || null;
}

function normalizeAnimationPayload(raw) {
  const animation = raw && typeof raw === 'object' ? raw : {};
  const clamp = (value, min, max, fallback) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, numeric));
  };

  const allowedThemes = new Set(['generic', 'space', 'atom', 'math', 'biology', 'earth', 'history']);
  const allowedMotions = new Set(['calm', 'pulse', 'orbit', 'wave', 'surge']);
  const allowedShapes = new Set(['icosahedron', 'sphere', 'torus', 'knot']);

  return {
    theme: allowedThemes.has(animation.theme) ? animation.theme : 'generic',
    motion: allowedMotions.has(animation.motion) ? animation.motion : 'pulse',
    shape: allowedShapes.has(animation.shape) ? animation.shape : 'icosahedron',
    intensity: clamp(animation.intensity, 0.1, 1, 0.55),
    accentHue: clamp(animation.accentHue, 0, 360, 170),
    cameraDistance: clamp(animation.cameraDistance, 3, 10, 5.5),
    particleSpread: clamp(animation.particleSpread, 6, 24, 13)
  };
}

function buildFallbackPayload(question, modelText) {
  const lower = question.toLowerCase();
  let theme = 'generic';
  let shape = 'icosahedron';
  let motion = 'pulse';

  if (/(atom|electron|proton|nucleus|molecule|chemistry)/.test(lower)) {
    theme = 'atom';
    shape = 'sphere';
    motion = 'orbit';
  } else if (/(space|planet|star|galaxy|black hole|universe)/.test(lower)) {
    theme = 'space';
    shape = 'torus';
    motion = 'wave';
  } else if (/(math|algebra|geometry|calculus|equation|number)/.test(lower)) {
    theme = 'math';
    shape = 'knot';
    motion = 'pulse';
  } else if (/(cell|biology|animal|plant|dna|human)/.test(lower)) {
    theme = 'biology';
    shape = 'sphere';
    motion = 'surge';
  } else if (/(earth|climate|weather|ocean|volcano|rock)/.test(lower)) {
    theme = 'earth';
    shape = 'icosahedron';
    motion = 'wave';
  } else if (/(history|war|empire|ancient|civilization)/.test(lower)) {
    theme = 'history';
    shape = 'knot';
    motion = 'calm';
  }

  return {
    answer: modelText || 'I can help with that. Ask about a topic and I will explain it while the scene shifts to match the concept.',
    animation: normalizeAnimationPayload({
      theme,
      shape,
      motion,
      intensity: 0.6,
      accentHue: theme === 'space' ? 215 : theme === 'math' ? 42 : theme === 'atom' ? 178 : 160,
      cameraDistance: theme === 'space' ? 7.4 : 5.4,
      particleSpread: theme === 'atom' ? 9 : 14
    })
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > 1024 * 1024) {
      throw new Error('Request body too large.');
    }
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new Error('Invalid JSON body.');
  }
}

function sanitizeUser(user) {
  return {
    email: user.email,
    createdAt: user.createdAt
  };
}

function getErrorMessage(error) {
  return error && error.message ? String(error.message) : String(error || 'Unknown error');
}

function classifyTutorError(label, error) {
  const message = getErrorMessage(error);
  const normalized = message.toLowerCase();
  const prefix = label.toLowerCase();

  if (
    normalized.includes('api key not valid') ||
    normalized.includes('permission denied') ||
    normalized.includes('service disabled') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  ) {
    return {
      code: `${prefix}_auth`,
      family: 'auth',
      label: `${label} authorization issue`,
      message
    };
  }

  if (
    normalized.includes('quota') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('rate limit') ||
    normalized.includes('429')
  ) {
    return {
      code: `${prefix}_quota`,
      family: 'quota',
      label: `${label} quota issue`,
      message
    };
  }

  if (
    normalized.includes('high demand') ||
    normalized.includes('unavailable') ||
    normalized.includes('temporarily busy') ||
    normalized.includes('503')
  ) {
    return {
      code: `${prefix}_unavailable`,
      family: 'unavailable',
      label: `${label} unavailable`,
      message
    };
  }

  if (
    normalized.includes('fetch failed') ||
    normalized.includes('network') ||
    normalized.includes('socket') ||
    normalized.includes('enotfound') ||
    normalized.includes('econnreset') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('deadline exceeded')
  ) {
    return {
      code: `${prefix}_network`,
      family: 'network',
      label: `${label} network issue`,
      message
    };
  }

  return {
    code: `${prefix}_error`,
    family: 'unknown',
    label: `${label} error`,
    message
  };
}

function isRetryableErrorMessage(message = '') {
  const normalized = String(message).toLowerCase();
  return (
    normalized.includes('429') ||
    normalized.includes('quota') ||
    normalized.includes('rate limit') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('high demand') ||
    normalized.includes('unavailable') ||
    normalized.includes('deadline exceeded') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout')
  );
}

function describeServiceError(label, detail) {
  if (!detail) {
    return `${label} could not be reached. I used a fallback explanation so the lesson can keep going.`;
  }

  if (detail.family === 'quota') {
    return `${label} hit a quota limit, so I used a fallback explanation to keep the lesson moving.`;
  }

  if (detail.family === 'unavailable') {
    return `${label} is temporarily busy. I used a fallback explanation so the lesson can keep going.`;
  }

  if (detail.family === 'auth') {
    return `${label} is configured but not authorized correctly right now, so I used a fallback explanation.`;
  }

  if (detail.family === 'network') {
    return `${label} could not be reached over the network, so I used a fallback explanation.`;
  }

  return `${label} could not be reached. I used a fallback explanation so the lesson can keep going.`;
}

async function runImageLookup(question, tutorPayload) {
  try {
    return await Promise.race([
      fetchTopicImage(question, tutorPayload),
      new Promise((resolve) => {
        setTimeout(() => resolve({
          error: 'Image generation timed out for this request.',
          source: 'timeout'
        }), 12000);
      })
    ]);
  } catch (error) {
    return {
      error: error.message || 'Image generation failed.',
      source: 'error'
    };
  }
}

async function fetchTutorResponse(question) {
  const providerAttempts = [];
  const providerFailures = [];

  if (process.env.GEMINI_API_KEY) {
    providerAttempts.push({
      label: 'Gemini',
      run: () => fetchGeminiResponse(question)
    });
  }

  for (const provider of providerAttempts) {
    try {
      const tutorPayload = await provider.run();
      const image = await runImageLookup(question, tutorPayload);
      return {
        ...tutorPayload,
        image,
        tutor: {
          live: true,
          provider: provider.label.toLowerCase(),
          fallbackReason: null,
          detail: null
        }
      };
    } catch (error) {
      const detail = classifyTutorError(provider.label, error);
      providerFailures.push({
        label: provider.label,
        error,
        detail
      });
      console.warn(`${provider.label} tutor request failed [${detail.code}]:`, detail.message);
    }
  }

  const fallbackPayload = buildFallbackPayload(
    question,
    'I could not reach the live tutor right now, so I am giving you a quick guided explanation based on the topic you asked about.'
  );
  const image = await runImageLookup(question, fallbackPayload);
  const primaryFailure = providerFailures[0];
  const failureDetail = primaryFailure ? primaryFailure.detail : null;
  const failureMessage = primaryFailure
    ? describeServiceError(primaryFailure.label, failureDetail)
    : 'No live AI provider is configured on the server, so I used the built-in lesson fallback.';

  return {
    ...fallbackPayload,
    answer: `${failureMessage}\n\n${fallbackPayload.answer}`,
    image,
    tutor: {
      live: false,
      provider: primaryFailure ? primaryFailure.label.toLowerCase() : 'fallback',
      fallbackReason: failureDetail ? failureDetail.code : 'no_live_provider',
      detail: failureDetail
        ? {
            family: failureDetail.family,
            label: failureDetail.label,
            message: failureDetail.message
          }
        : {
            family: 'configuration',
            label: 'No live provider configured',
            message: 'No Gemini API key is loaded on this server.'
          }
    }
  };
}

async function fetchGeminiResponse(question) {
  if (typeof fetch !== 'function') {
    throw new Error('This app requires Node.js 18 or newer because it uses the built-in fetch API.');
  }

  const instructions = [
    'You are Nexus Learn, a concise educational tutor.',
    'Answer the learner clearly in 2 to 5 sentences.',
    'If the question is ambiguous, answer helpfully and note any uncertainty.',
    'Return valid JSON only with the shape {"answer": string, "animation": {...}}.',
    'animation.theme must be one of generic, space, atom, math, biology, earth, history.',
    'animation.motion must be one of calm, pulse, orbit, wave, surge.',
    'animation.shape must be one of icosahedron, sphere, torus, knot.',
    'animation.intensity must be a number from 0.1 to 1.',
    'animation.accentHue must be a number from 0 to 360.',
    'animation.cameraDistance must be a number from 3 to 10.',
    'animation.particleSpread must be a number from 6 to 24.'
  ].join(' ');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`;
  const apiResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: instructions }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: question }]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json'
      }
    }),
    signal: AbortSignal.timeout(30000)
  });

  const payload = await apiResponse.json().catch(() => ({}));

  if (!apiResponse.ok) {
    const message =
      payload.error && payload.error.message
        ? payload.error.message
        : `Gemini request failed with status ${apiResponse.status}.`;
    throw new Error(message);
  }

  const rawText =
    payload &&
    payload.candidates &&
    payload.candidates[0] &&
    payload.candidates[0].content &&
    Array.isArray(payload.candidates[0].content.parts)
      ? payload.candidates[0].content.parts
          .map((part) => (typeof part.text === 'string' ? part.text : ''))
          .join('')
      : '';

  try {
    const parsed = JSON.parse(rawText);
    return {
      answer: parsed.answer || buildFallbackPayload(question).answer,
      animation: normalizeAnimationPayload(parsed.animation)
    };
  } catch (error) {
    return buildFallbackPayload(question, rawText);
  }
}

function buildImagePrompt(question, tutorPayload) {
  const animation = tutorPayload && tutorPayload.animation ? tutorPayload.animation : {};
  const theme = animation.theme || 'generic';
  const motion = animation.motion || 'pulse';
  const shape = animation.shape || 'icosahedron';
  const answer = tutorPayload && tutorPayload.answer ? tutorPayload.answer : '';

  return [
    'Create a detailed educational illustration for a learning interface.',
    `Topic: ${question}.`,
    answer ? `Teaching summary: ${answer}` : '',
    `Visual theme: ${theme}.`,
    `Motion inspiration: ${motion}.`,
    `Central geometry inspiration: ${shape}.`,
    'Style: cinematic, high-detail, luminous, clean composition, suitable for students, no watermarks, no text labels.'
  ]
    .filter(Boolean)
    .join(' ');
}

async function fetchTopicImage(question, tutorPayload) {
  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
    const searchedImage = await fetchGoogleTopicImage(question, tutorPayload).catch(() => null);
    if (searchedImage) {
      return searchedImage;
    }
  }

  if (process.env.HF_TOKEN) {
    const huggingFaceImage = await fetchHuggingFaceImage(question, tutorPayload).catch(() => null);
    if (huggingFaceImage) {
      return huggingFaceImage;
    }
  }

  return null;
}

async function fetchHuggingFaceImage(question, tutorPayload) {
  const imagePrompt = buildImagePrompt(question, tutorPayload);
  const endpoint = `https://router.huggingface.co/hf-inference/models/${DEFAULT_HF_IMAGE_MODEL}`;

  const apiResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.HF_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      inputs: imagePrompt,
      parameters: {
        width: 1280,
        height: 720
      }
    }),
    signal: AbortSignal.timeout(60000)
  });

  if (!apiResponse.ok) {
    const text = await apiResponse.text().catch(() => '');
    throw new Error(text || `Hugging Face image request failed with status ${apiResponse.status}.`);
  }

  const mimeType = apiResponse.headers.get('content-type') || 'image/png';
  const bytes = Buffer.from(await apiResponse.arrayBuffer());

  if (!bytes.length) {
    return null;
  }

  return {
    source: 'generated',
    mimeType,
    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`
  };
}

function buildSearchQuery(question, tutorPayload) {
  const answer = tutorPayload && tutorPayload.answer ? tutorPayload.answer : '';
  const condensedAnswer = answer.split(/[.!?]/).slice(0, 2).join(' ').trim();
  return [question, condensedAnswer, 'educational illustration OR photo']
    .filter(Boolean)
    .join(' ');
}

async function fetchGoogleTopicImage(question, tutorPayload) {
  const params = new URLSearchParams({
    key: process.env.GOOGLE_SEARCH_API_KEY,
    cx: process.env.GOOGLE_SEARCH_CX,
    q: buildSearchQuery(question, tutorPayload),
    searchType: 'image',
    safe: 'active',
    num: '1',
    imgSize: 'xlarge'
  });

  const apiResponse = await fetch(`${GOOGLE_SEARCH_API_URL}?${params.toString()}`, {
    method: 'GET',
    signal: AbortSignal.timeout(20000)
  });

  const payload = await apiResponse.json().catch(() => ({}));

  if (!apiResponse.ok) {
    const message =
      payload.error && payload.error.message
        ? payload.error.message
        : `Google image search failed with status ${apiResponse.status}.`;
    throw new Error(message);
  }

  const firstItem = payload && Array.isArray(payload.items) ? payload.items[0] : null;

  if (!firstItem || typeof firstItem.link !== 'string') {
    return null;
  }

  return {
    source: 'search',
    url: firstItem.link,
    title: typeof firstItem.title === 'string' ? firstItem.title : '',
    contextLink:
      firstItem.image && typeof firstItem.image.contextLink === 'string'
        ? firstItem.image.contextLink
        : ''
  };
}

function isSafePath(requestPath) {
  const normalized = requestPath === '/' ? '/nexus_demo.html' : requestPath;
  const cleanPath = path.normalize(normalized).replace(/^(\.\.[\\/])+/, '');
  const resolvedPath = path.resolve(baseDir, `.${cleanPath}`);
  return resolvedPath.startsWith(baseDir + path.sep) || resolvedPath === baseDir;
}

function getStaticFilePath(requestPath) {
  const normalized = requestPath === '/' ? '/nexus_demo.html' : requestPath;
  return path.resolve(baseDir, `.${path.normalize(normalized)}`);
}

function serveStatic(req, res) {
  const requestPath = req.url.split('?')[0];

  if (!isSafePath(requestPath)) {
    sendJson(res, 403, { error: 'Forbidden path.', reason: 'forbidden_path', runtime: getRuntimeInfo() });
    return;
  }

  const filePath = getStaticFilePath(requestPath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      Object.entries(buildCommonHeaders()).forEach(([key, value]) => res.setHeader(key, value));
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      ...buildCommonHeaders()
    });

    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleApiChat(req, res) {
  try {
    const authenticatedUser = getAuthenticatedUser(req);
    if (!authenticatedUser) {
      sendJson(res, 401, {
        error: 'Please sign in to continue.',
        reason: 'auth_session_issue',
        runtime: getRuntimeInfo()
      });
      return;
    }

    const body = await readJsonBody(req);
    const question = typeof body.question === 'string' ? body.question.trim() : '';

    if (!question) {
      sendJson(res, 400, {
        error: 'Please send a non-empty question.',
        reason: 'invalid_question',
        runtime: getRuntimeInfo()
      });
      return;
    }

    const responsePayload = await fetchTutorResponse(question);
    sendJson(res, 200, {
      ...responsePayload,
      runtime: getRuntimeInfo()
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error.message || 'Unexpected server error.',
      reason: 'server_error',
      runtime: getRuntimeInfo()
    });
  }
}

async function handleRegister(req, res) {
  try {
    const body = await readJsonBody(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password.trim() : '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJson(res, 400, { error: 'Enter a valid email address.' });
      return;
    }

    if (password.length < 8) {
      sendJson(res, 400, { error: 'Password must be at least 8 characters long.' });
      return;
    }

    const users = getUsers();
    if (users.some((user) => user.email === email)) {
      sendJson(res, 409, { error: 'An account with this email already exists.' });
      return;
    }

    const passwordRecord = hashPassword(password);
    const newUser = {
      email,
      salt: passwordRecord.salt,
      passwordHash: passwordRecord.hash,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);
    setSessionCookie(res, email);
    sendJson(res, 201, { user: sanitizeUser(newUser), runtime: getRuntimeInfo() });
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Could not create account.', reason: 'server_error', runtime: getRuntimeInfo() });
  }
}

async function handleLogin(req, res) {
  try {
    const body = await readJsonBody(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password.trim() : '';
    const user = getUsers().find((entry) => entry.email === email);

    if (!user || !validatePassword(password, user)) {
      sendJson(res, 401, { error: 'Incorrect email or password.' });
      return;
    }

    setSessionCookie(res, email);
    sendJson(res, 200, { user: sanitizeUser(user), runtime: getRuntimeInfo() });
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Could not sign in.', reason: 'server_error', runtime: getRuntimeInfo() });
  }
}

function handleLogout(res) {
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true, runtime: getRuntimeInfo() });
}

function handleSession(req, res) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    sendJson(res, 200, { authenticated: false, runtime: getRuntimeInfo() });
    return;
  }

  sendJson(res, 200, {
    authenticated: true,
    user: sanitizeUser(user),
    runtime: getRuntimeInfo()
  });
}

function handleHealth(req, res) {
  const user = getAuthenticatedUser(req);
  sendJson(res, 200, {
    ok: true,
    runtime: getRuntimeInfo(),
    auth: {
      authenticated: Boolean(user),
      email: user ? user.email : null
    }
  });
}

function createServer() {
  return http.createServer((req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: 'Missing request URL.' });
      return;
    }

    const requestPath = req.url.split('?')[0];

    if (req.method === 'POST' && requestPath === '/api/chat') {
      handleApiChat(req, res);
      return;
    }

    if (req.method === 'POST' && requestPath === '/api/auth/register') {
      handleRegister(req, res);
      return;
    }

    if (req.method === 'POST' && requestPath === '/api/auth/login') {
      handleLogin(req, res);
      return;
    }

    if (req.method === 'POST' && requestPath === '/api/auth/logout') {
      handleLogout(res);
      return;
    }

    if (req.method === 'GET' && requestPath === '/api/auth/session') {
      handleSession(req, res);
      return;
    }

    if (req.method === 'GET' && requestPath === '/api/health') {
      handleHealth(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }

    serveStatic(req, res);
  });
}

function openLocalBrowser(url) {
  if (browserOpened || process.platform !== 'win32' || process.env.NEXUS_AUTO_OPEN !== '1' || RUNTIME_ENV !== 'LOCAL') {
    return;
  }

  browserOpened = true;
  exec(`start "" "${url}"`);
}

function startServer(port = DEFAULT_PORT, attempts = 0) {
  if (attempts > 5) {
    console.error('Too many port attempts. Please free a port and retry.');
    process.exit(1);
  }

  const server = createServer();

  server.listen(port, () => {
    activePort = port;
    const url = `http://localhost:${port}/`;
    console.log(`[${RUNTIME_ENV}] Nexus Learn running at ${url}`);
    console.log(`[${RUNTIME_ENV}] Health endpoint: ${url}api/health`);
    console.log(`[${RUNTIME_ENV}] Tutor model: ${DEFAULT_GEMINI_MODEL}`);
    console.log(`[${RUNTIME_ENV}] Gemini key loaded: ${process.env.GEMINI_API_KEY ? 'yes' : 'no'}`);
    openLocalBrowser(url);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} is already in use. Trying ${port + 1}...`);
      startServer(port + 1, attempts + 1);
      return;
    }

    console.error('Server error:', err);
    process.exit(1);
  });
}

startServer();
