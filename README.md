# Nexus Learn 3D

An API-backed educational demo with a live tutor response pipeline, model-generated topic images, and a Three.js scene that changes shape, color, motion, camera depth, and particle spread based on the answer.

## Quick start

### One-click launch on Windows

1. Copy `.env.example` to `.env`
2. Put your Gemini key in `.env`
3. Optional: add Google Custom Search credentials if you want real web images before AI-generated fallback
4. Double-click `launch_nexus.bat`
5. The server will print and open the exact local URL it selected. If `3001` is busy, it will move to the next free port automatically.

```text
http://localhost:3001/  (or the next free localhost port)
```

### Manual start

1. Open a terminal in `D:\nexus_demo`
2. Set your API key

PowerShell:

```powershell
$env:GEMINI_API_KEY="your_gemini_api_key_here"
```

Optional model overrides:

```powershell
$env:GEMINI_MODEL="gemini-2.5-flash"
$env:GEMINI_FALLBACK_MODELS="gemini-2.5-flash-lite,gemini-2.0-flash"
$env:GOOGLE_SEARCH_API_KEY="your_google_custom_search_api_key_here"
$env:GOOGLE_SEARCH_CX="your_programmable_search_engine_id_here"
$env:HF_TOKEN="your_huggingface_token_here"
```

3. Start the server:

```bash
npm start
```

4. Open:

```text
http://localhost:3001/  (or the next free localhost port printed by the server)
```

## Deploy on Railway

This project is ready for Railway with config-as-code in [railway.toml](/D:/nexus_demo/railway.toml).

Recommended reason to use Railway for this project:
- your Render deployment is reaching Gemini with the correct key, but Gemini reports that the Render runtime location is not supported for API use
- Railway lets you choose a deploy region, and this repo is preconfigured for `asia-southeast1-eqsg3a` (Singapore)

### Railway steps

1. Push the latest code to GitHub
2. Create a new project in Railway
3. Choose `Deploy from GitHub repo`
4. Select this repository
5. Railway will detect the app and use:

```text
Start command: npm start
Healthcheck path: /api/health
Region: asia-southeast1-eqsg3a
```

6. In Railway Variables, add:

```text
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-2.5-flash
GEMINI_FALLBACK_MODELS=gemini-2.5-flash-lite,gemini-2.0-flash
GOOGLE_SEARCH_API_KEY=your_google_search_key
GOOGLE_SEARCH_CX=your_programmable_search_engine_id
HF_TOKEN=your_huggingface_token
AUTH_SECRET=any_long_random_secret
```

7. Deploy the service
8. Open the Railway URL
9. Sign in and test:

```text
/api/health
/api/health/gemini
```

### What Railway uses from this repo

- [railway.toml](/D:/nexus_demo/railway.toml) sets the start command, healthcheck, restart policy, and preferred region
- [server.js](/D:/nexus_demo/server.js) already listens on Railway's injected `PORT`
- [server.js](/D:/nexus_demo/server.js) already exposes `/api/health` for deployment health checks
- [server.js](/D:/nexus_demo/server.js) already exposes `/api/health/gemini` so you can verify live Gemini reachability from the deployed runtime

## How it works

- `server.js` serves the static app and exposes `POST /api/chat`
- `GET /api/health` reports the active runtime, port, tutor model, and whether the Gemini key is loaded
- The root URL `/` now opens the app directly, so you do not need to type the HTML filename
- The backend calls Gemini when `GEMINI_API_KEY` is present
- If the primary Gemini model is under heavy demand, the backend retries and can fall through to `GEMINI_FALLBACK_MODELS`
- The model is asked for JSON with both:
  - a tutor answer
  - animation settings for the 3D scene
- When `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` are configured, the backend first tries Google Custom Search image results for the topic
- If Google image search is unavailable or returns nothing usable, the backend tries Hugging Face image generation when `HF_TOKEN` is configured
- `nexus_demo.html` sends the user question to the backend and smoothly animates toward the returned visual state

## Requirements

- Node.js 18 or newer
- A valid `GEMINI_API_KEY`
- Optional for web image lookup: `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX`
- Optional for AI image fallback: `HF_TOKEN`
- Internet access for:
  - the Gemini API
  - the Google Custom Search JSON API when web image lookup is enabled
  - the Hugging Face inference API when HF image fallback is enabled
  - the Three.js CDN script

## Notes

- Opening the HTML with `file://` will not work for live API requests. Use the local server.
- `launch_nexus.bat` is the easiest local entry point if you do not want to use `npm start`.
- The UI shows a runtime badge so you can tell whether you are on `LOCAL` or `RENDER`, along with the active port and tutor model.
- If the model returns non-JSON text, the server falls back to a best-effort animation profile based on the question.
- If Gemini falls back, the UI now shows a precise reason category such as quota, high demand, auth, or network.
- If `/api/health/gemini` reports `User location is not supported for the API use`, the problem is the deployment region/provider, not the API key itself.
- Some external image hosts may block hotlinking; in those cases the app falls back to any available configured image provider.
- If image generation or image search is unavailable, the UI shows the returned error message in the image panel.
