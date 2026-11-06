# Pocket Agent

A small, static AI coding workspace designed for Cloudflare Pages.

## Included in this starter

- Mobile-friendly chat UI.
- Local Hugging Face model loading through Transformers.js.
- Project file manager with browser-local persistence.
- JavaScript execution in a sandboxed iframe.
- Python execution in a dedicated Web Worker using Pyodide.
- HTML project preview in a sandboxed iframe.
- ZIP export of project files.

## Deploy to Cloudflare Pages

1. Create a GitHub repository named `pocket-agent`.
2. Upload the contents of this folder to the repository root (not the ZIP itself).
3. In Cloudflare, open **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
4. Select your GitHub repository.
5. Framework preset: **None**.
6. Build command: leave blank.
7. Build output directory: `/` (or `.` if the dashboard requires a relative path).
8. Deploy.

This is a static site. It does not need a Node build step or server.

## Run locally

You need to serve the folder over HTTP; opening `index.html` directly with `file://` may block module imports.

For example, from this folder:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## First launch

1. Open the site.
2. Tap **Load model**.
3. Keep the default model ID: `onnx-community/SmolLM2-360M-Instruct-ONNX`.
4. Tap **Download & load** and wait for the model to download.
5. Try: "Create a simple landing page. Make index.html, styles.css and script.js."

The first model download can be large and may be slow on mobile. Keep the page open while it loads. Browser/device memory limits may prevent some devices from loading the model. A failed local model load does not mean the workspace tools are broken.

## Important limitations and safety

- The local model is downloaded from Hugging Face and runs on the user's device when supported. No Hugging Face API token is included or required for this local-model path.
- The browser does not guarantee that the selected model will fit in memory or run quickly. Model support, WebGPU availability, and device memory vary.
- This prototype asks the model to emit simple tool-call markup. Small models may occasionally produce malformed tool calls or fail to follow the tool instructions.
- JavaScript runs inside a sandboxed iframe. Python runs in a dedicated Web Worker using Pyodide. These are useful isolation boundaries for experimentation, not a hardened hostile-code security boundary. Do not use this prototype to execute untrusted code containing sensitive data.
- Browser Python is not a full Linux environment. Browser JavaScript is not a full Node.js terminal. Native packages, filesystem access, subprocesses, and arbitrary system commands are not available.
- Project files are stored in this browser's local storage. Clearing browser site data can delete them. Export ZIP backups regularly.
- This app has no login, cloud database, cross-device sync, or cloud execution service yet.
- Never put private API keys, passwords, client secrets, or production credentials into generated code or browser storage.

## Main files

- `index.html` — interface and dialogs.
- `styles.css` — responsive styling.
- `app.js` — model loading, agent loop, file tools, and sandbox runners.
