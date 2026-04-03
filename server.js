// Nexus Learn 3D development server
// Run: node server.js
// Then open: http://localhost:3001/

const http = require('http');
const fs = require('fs');
const path = require('path');

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const baseDir = path.resolve(__dirname);

loadEnvFile(path.join(baseDir, '.env'));

const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3001;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DEFAULT_GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GOOGLE_SEARCH_API_URL = 'https://customsearch.googleapis.com/customsearch/v1';
const DEFAULT_HF_IMAGE_MODEL = process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell';

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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
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

async function fetchTutorResponse(question) {
  if (process.env.GEMINI_API_KEY) {
    const tutorPayload = await fetchGeminiResponse(question);
    const image = await fetchTopicImage(question, tutorPayload).catch((error) => ({
      error: error.message || 'Image generation failed.',
      source: 'error'
    }));
    return { ...tutorPayload, image };
  }

  const tutorPayload = await fetchOpenAIResponse(question);
  const image = await fetchTopicImage(question, tutorPayload).catch((error) => ({
    error: error.message || 'Image lookup failed.',
    source: 'error'
  }));
  return { ...tutorPayload, image };
}

async function fetchOpenAIResponse(question) {
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

  const apiResponse = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: instructions }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: question }]
        }
      ],
      text: {
        format: { type: 'json_object' }
      }
    }),
    signal: AbortSignal.timeout(30000)
  });

  const payload = await apiResponse.json().catch(() => ({}));

  if (!apiResponse.ok) {
    const message =
      payload.error && payload.error.message
        ? payload.error.message
        : `OpenAI request failed with status ${apiResponse.status}.`;
    throw new Error(message);
  }

  const rawText = typeof payload.output_text === 'string' ? payload.output_text : '';

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

  if (!process.env.GEMINI_API_KEY) {
    return null;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_IMAGE_MODEL}:generateContent`;
  const imagePrompt = buildImagePrompt(question, tutorPayload);

  const apiResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: imagePrompt }]
        }
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE']
      }
    }),
    signal: AbortSignal.timeout(45000)
  });

  const payload = await apiResponse.json().catch(() => ({}));

  if (!apiResponse.ok) {
    const message =
      payload.error && payload.error.message
        ? payload.error.message
        : `Gemini image request failed with status ${apiResponse.status}.`;
    throw new Error(message);
  }

  const parts =
    payload &&
    Array.isArray(payload.candidates) &&
    payload.candidates[0] &&
    payload.candidates[0].content &&
    Array.isArray(payload.candidates[0].content.parts)
      ? payload.candidates[0].content.parts
      : [];

  const imagePart = parts.find(
    (part) =>
      part &&
      part.inlineData &&
      typeof part.inlineData.data === 'string' &&
      typeof part.inlineData.mimeType === 'string'
  );

  const textPart = parts.find((part) => part && typeof part.text === 'string');

  if (!imagePart) {
    if (textPart && textPart.text) {
      throw new Error(textPart.text);
    }
    return null;
  }

  return {
    source: 'generated',
    mimeType: imagePart.inlineData.mimeType,
    dataUrl: `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`
  };
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
    sendJson(res, 403, { error: 'Forbidden path.' });
    return;
  }

  const filePath = getStaticFilePath(requestPath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    });

    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleApiChat(req, res) {
  try {
    const body = await readJsonBody(req);
    const question = typeof body.question === 'string' ? body.question.trim() : '';

    if (!question) {
      sendJson(res, 400, { error: 'Please send a non-empty question.' });
      return;
    }

    const responsePayload = await fetchTutorResponse(question);
    sendJson(res, 200, responsePayload);
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Unexpected server error.' });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: 'Missing request URL.' });
      return;
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/api/chat') {
      handleApiChat(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }

    serveStatic(req, res);
  });
}

function startServer(port = DEFAULT_PORT, attempts = 0) {
  if (attempts > 5) {
    console.error('Too many port attempts. Please free a port and retry.');
    process.exit(1);
  }

  const server = createServer();

  server.listen(port, () => {
    console.log(`Nexus Learn running at http://localhost:${port}/`);
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
