// A small picture of every model of dota2-models for the download site's cards: drawn in headless
// Chrome by lib/preview-page/ (three.js, the model in its idle pose, a three-quarter view, a
// transparent background) and kept next to the models as previews/<model path>.webp
// (previews/models/heroes/axe/axe.webp for models/heroes/axe/axe.glb).
//
// Only models new or changed since the last run (state/previews.json keeps each model's size when
// its picture was made); pictures of models gone from the dataset are removed. The models come from
// the dataset itself (its files.json and the .glb.gz copies), so it runs after models.js, before
// files-list. Chrome draws with the GPU where there is one (a first run of every model is quicker on
// a PC), else with its software renderer.
//
//   HF_TOKEN=... node exporters/previews.js [--no-upload] [--limit N] [--pages N] [--retry-failed]
//   CHROME_PATH=...  where Chrome is when not in its usual place
const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const { spawn } = require("child_process");
const hf = require("../lib/hf");
const { DATASETS } = require("../lib/datasets");

const OWNER = "Sqls1";
const STATE_FILE = "state/previews.json";
const PREFIX = "previews/";
const SIZE = 320;
const BATCH = 1000;
const temp = path.resolve("./temp/previews");
const PAGE_DIR = path.join(__dirname, "../lib/preview-page");
const THREE_DIR = path.join(__dirname, "../node_modules/three");

const fileUrl = (file) => `https://huggingface.co/datasets/${OWNER}/${DATASETS.models}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
const previewOf = (model) => `${PREFIX}${model.replace(/\.glb$/, ".webp")}`;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function modelList() {
  const res = await fetch(`${fileUrl("files.json")}.gz`);
  if (!res.ok) throw new Error(`files.json: ${res.status}`);
  return JSON.parse(zlib.gunzipSync(Buffer.from(await res.arrayBuffer()))).files;
}

// A file of dota2-models, fetched with the token (the Hub limits anonymous requests far sooner) and
// again after a dropped connection or a "too many requests", waiting as long as the Hub asks
async function download(file, accessToken) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(fileUrl(file), { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`${res.status}`), { final: true });
      if (attempt >= 8) throw new Error(`${res.status}`);
      const wait = Number(res.headers.get("retry-after")) || 5 * attempt;
      console.log(`  ${file}: ${res.status}, again in ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    } catch (error) {
      if (error.final || attempt >= 8) throw error;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

// The render page, three.js, and the models (/model/<path in dota2-models>), served to Chrome
function serve(accessToken) {
  const types = { ".html": "text/html", ".js": "text/javascript" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x").pathname;
    if (url.startsWith("/model/")) {
      download(decodeURIComponent(url.slice(7)), accessToken).then(
        (body) => res.writeHead(200, { "content-type": "application/octet-stream" }).end(body),
        (error) => res.writeHead(502).end(String(error.message))
      );
      return;
    }
    const file = url.startsWith("/three/") ? path.join(THREE_DIR, url.slice(7)) : path.join(PAGE_DIR, url.slice(1));
    const root = url.startsWith("/three/") ? THREE_DIR : PAGE_DIR;
    if (!path.resolve(file).startsWith(root) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}

async function launchChrome() {
  const port = 9400 + Math.floor(Math.random() * 500);
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(temp, "chrome")}`,
    "--no-first-run",
    "--ignore-gpu-blocklist",
    "--enable-gpu",
    "--enable-unsafe-swiftshader",
    "about:blank",
  ];
  if (process.getuid?.() === 0) args.unshift("--no-sandbox");
  const chrome = spawn(chromePath(), args, { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return { chrome, port };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Chrome did not start");
}

// One tab driven over the DevTools protocol
async function openPage(port, url) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const call = (method, params, timeout = 180_000) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => (pending.delete(n), reject(new Error(`${method} timed out`))), timeout);
      pending.set(n, (msg) => (clearTimeout(timer), msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression, timeout) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split("\n")[0] || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitReady = async () => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate("window.ready === true").catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("The render page did not load");
  };
  await waitReady();
  return {
    render: (model, gz) => evaluate(`render(${JSON.stringify(`/model/${encodeURIComponent(gz ? `${model}.gz` : model)}`)}, ${gz})`, 600_000),
    reload: async () => {
      await call("Page.reload", {});
      await waitReady();
    },
    close: () => ws.close(),
  };
}

async function main() {
  const accessToken = process.env.HF_TOKEN;
  const upload = !process.argv.includes("--no-upload");
  if (upload && !accessToken) {
    console.error("Usage: HF_TOKEN=... node exporters/previews.js [--no-upload] [--limit N] [--pages N] [--retry-failed]");
    process.exit(1);
  }
  const limit = Number(argValue("--limit")) || Infinity;
  const pageCount = Number(argValue("--pages")) || 4;
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  state.done ??= {};
  state.failed ??= {};
  const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

  const files = await modelList();
  const paths = new Set(files.map(([p]) => p));
  const models = files.filter(([p]) => p.endsWith(".glb") && !p.startsWith(PREFIX));
  const retry = process.argv.includes("--retry-failed");
  const todo = models
    .filter(([p, size]) => state.done[p] !== size && (retry || state.failed[p] !== size))
    .slice(0, limit);
  const repo = upload ? await hf.prepareRepo(accessToken, DATASETS.models) : null;

  // Pictures of models no longer in the dataset
  const gone = Object.keys(state.done).filter((p) => !paths.has(p));
  if (gone.length && upload) {
    await hf.remove(repo, accessToken, gone.map(previewOf).filter((p) => paths.has(p)), "Remove previews of removed models");
    for (const p of gone) delete state.done[p];
    saveState();
  }
  console.log(`previews: ${models.length} models, ${todo.length} to draw`);
  if (!todo.length) return;

  fs.mkdirSync(temp, { recursive: true });
  const server = await serve(accessToken);
  const { chrome, port } = await launchChrome();
  const pageUrl = `http://127.0.0.1:${server.address().port}/render.html?size=${SIZE}`;
  const pages = [];
  for (let i = 0; i < pageCount; i++) pages.push(await openPage(port, pageUrl));

  // Drawn pictures go up in batches while the next ones are drawn
  let ready = [];
  let sending = Promise.resolve();
  const flush = () => {
    const batch = ready;
    ready = [];
    if (!batch.length) return;
    sending = sending.then(async () => {
      if (upload) {
        await hf.upload(repo, accessToken, batch.map((b) => ({ path: b.preview, file: b.file })), "Update model previews", { gzip: false });
        for (const b of batch) fs.rmSync(b.file, { force: true });
      }
      for (const b of batch) state.done[b.model] = b.size;
      saveState();
    });
  };

  let next = 0;
  let drawn = 0;
  let failed = 0;
  const started = Date.now();
  async function worker(page) {
    let errorsInRow = 0;
    while (next < todo.length) {
      const [model, size] = todo[next++];
      try {
        const data = await page.render(model, paths.has(`${model}.gz`));
        errorsInRow = 0;
        if (!data) {
          // Nothing to draw (an empty model, only attachments): no picture, not tried again
          state.failed[model] = size;
          failed++;
          continue;
        }
        const preview = previewOf(model);
        const file = path.join(temp, "out", preview);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
        delete state.failed[model];
        ready.push({ model, size, preview, file });
        drawn++;
        if (ready.length >= BATCH) flush();
      } catch (error) {
        state.failed[model] = size;
        failed++;
        console.log(`  ${model}: ${error.message}`);
        // A page that keeps failing (lost its WebGL context, ran out of memory) starts again
        if (++errorsInRow >= 3) {
          await page.reload().catch(() => {});
          errorsInRow = 0;
        }
      }
      const done = drawn + failed;
      if (done % 200 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log(`  ${done}/${todo.length} (${drawn} drawn, ${failed} without), ${rate.toFixed(1)}/s, ${Math.round((todo.length - done) / rate / 60)} min left`);
      }
    }
  }
  try {
    await Promise.all(pages.map(worker));
    flush();
    await sending;
  } finally {
    saveState();
    for (const page of pages) page.close();
    chrome.kill();
    server.close();
  }
  console.log(`previews: ${drawn} drawn, ${failed} without a picture, ${Math.round((Date.now() - started) / 1000)} s`);
}

module.exports = { main };

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}
