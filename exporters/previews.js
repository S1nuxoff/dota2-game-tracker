// A small picture of every model of dota2-models for the download site's cards: drawn in headless
// Chrome by lib/preview-page/ (three.js, the model in its idle pose, a three-quarter view, a
// transparent background) and kept next to the models as previews/<model path>.webp
// (previews/models/heroes/axe/axe.webp for models/heroes/axe/axe.glb).
//
// Each model's measures go to state/previews.json too (meta: [file size, width, height, depth, triangles,
// animations, texture names], from the glb itself), which catalog.js turns into the site's list of models.
//
// Only models new or changed since the last run (state/previews.json keeps each model's size when
// its picture was made); pictures of models gone from the dataset are removed. The models come from
// the dataset itself (its files.json and the .glb.gz copies), so it runs after models.js, before
// files-list. Chrome draws with the GPU where there is one (a first run of every model is quicker on
// a PC), else with its software renderer.
//
//   HF_TOKEN=... node exporters/previews.js [--no-upload] [--limit N] [--pages N] [--retry-failed]
//   HF_TOKEN=... node exporters/previews.js --meta-only     the measures of models drawn before, no drawing
//   --view top: the view of a match instead (lib/preview-page/render.js), to previews/top/<model path>.webp,
//   for search by screenshot (state in the same file, under "top"); --only a.glb,b.glb: these models only
//   CHROME_PATH=...  where Chrome is when not in its usual place
const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
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

const fileUrl = (file, repo = DATASETS.models) => `https://huggingface.co/datasets/${OWNER}/${repo}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
// The view being drawn: "front" (the cards') or "top" (a match's), set by main
let VIEW = "front";
let VIEW_DIR = "";
const previewOf = (model) => `${PREFIX}${VIEW_DIR}${model.replace(/\.glb$/, ".webp")}`;

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
async function download(file, accessToken, repo) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(fileUrl(file, repo), { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
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

// The tints the maps give materials: many props and trees are grey in their own files and coloured
// where a map places them (a tint per placement, kept in the exported map scenes as each material's
// base colour). From the JSON of every main map (scenes/dota*.glb in dota2-maps, read alone with a
// range request), the main map first, then the tint most placements give: { vmat path: [r, g, b] }
async function mapTints(accessToken) {
  const list = JSON.parse(zlib.gunzipSync(await download("files.json.gz", accessToken, DATASETS.maps))).files;
  const maps = list.map(([p]) => p).filter((p) => /^scenes\/dota(_[a-z0-9]+)*\.glb$/.test(p)).sort((a, b) => (a === "scenes/dota.glb" ? -1 : b === "scenes/dota.glb" ? 1 : a.localeCompare(b)));
  const headers = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
  const counts = new Map();
  const first = new Map();
  for (const map of maps) {
    try {
      const head = Buffer.from(await (await fetch(fileUrl(map, DATASETS.maps), { headers: { ...headers, range: "bytes=0-19" } })).arrayBuffer());
      const length = head.readUInt32LE(12);
      const json = JSON.parse(Buffer.from(await (await fetch(fileUrl(map, DATASETS.maps), { headers: { ...headers, range: `bytes=20-${19 + length}` } })).arrayBuffer()));
      for (const m of json.materials || []) {
        const name = m.extras?.vmat?.Name?.toLowerCase();
        const f = m.pbrMetallicRoughness?.baseColorFactor;
        if (!name || !f || f.slice(0, 3).every((v) => v === 1)) continue;
        const tint = f.slice(0, 3).map((v) => Math.round(v * 1000) / 1000);
        if (!first.has(name)) first.set(name, map);
        if (first.get(name) !== map) continue;
        const c = counts.get(name) || new Map();
        const k = tint.join(",");
        c.set(k, (c.get(k) || 0) + 1);
        counts.set(name, c);
      }
    } catch (error) {
      console.log(`  ${map}: no tints (${error.message})`);
    }
  }
  const tints = {};
  for (const [name, c] of counts) tints[name] = [...c.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
  console.log(`previews: tints of ${Object.keys(tints).length} materials from ${maps.length} maps`);
  return tints;
}

// A model's measures: [width, height, depth] of its meshes as exported (skinned ones in their bind
// pose), triangles, animations, and the names of its textures (the game's, <name>_<hash>.vtex, which
// dota2-textures keeps as <name>_<hash>.png)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
async function measure(buffer) {
  const doc = await io.readBinary(new Uint8Array(buffer));
  const root = doc.getRoot();
  let triangles = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    // A skinned mesh's vertices are placed by its bones, not by its node
    const m = node.getSkin() ? null : node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      if (!position) continue;
      if (prim.getMode() === 4) triangles += Math.floor((prim.getIndices()?.getCount() ?? position.getCount()) / 3);
      // From the vertices themselves: some files carry a wrong min and max
      const array = position.getArray();
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < array.length; v += 3) {
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], array[v + i]);
          hi[i] = Math.max(hi[i], array[v + i]);
        }
      }
      if (!Number.isFinite(lo[0])) continue;
      for (const x of [lo[0], hi[0]]) {
        for (const y of [lo[1], hi[1]]) {
          for (const z of [lo[2], hi[2]]) {
            const p = m ? [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]] : [x, y, z];
            for (let i = 0; i < 3; i++) {
              min[i] = Math.min(min[i], p[i]);
              max[i] = Math.max(max[i], p[i]);
            }
          }
        }
      }
    }
  }
  const dims = Number.isFinite(min[0]) ? max.map((v, i) => Math.round((v - min[i]) * 1000) / 1000) : [0, 0, 0];
  const textures = [...new Set(root.listTextures().map((t) => t.getName().replace(/\.vtex$/, "")).filter(Boolean))];
  return [...dims, triangles, root.listAnimations().length, textures];
}

// The measures of each model served to Chrome, by model path
const measured = new Map();
async function measureFile(file, body) {
  const model = file.replace(/\.gz$/, "");
  try {
    measured.set(model, await measure(file.endsWith(".gz") ? zlib.gunzipSync(body) : body));
  } catch (error) {
    console.log(`  ${model}: not measured (${error.message})`);
  }
}

// The render page, three.js, and the models (/model/<path in dota2-models>), served to Chrome
function serve(accessToken) {
  const types = { ".html": "text/html", ".js": "text/javascript" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x").pathname;
    // A scene of dota2-maps (/scene/<path>), for the views of the map
    if (url.startsWith("/scene/")) {
      download(decodeURIComponent(url.slice(7)), accessToken, DATASETS.maps).then(
        (body) => res.writeHead(200, { "content-type": "application/octet-stream" }).end(body),
        (error) => res.writeHead(502).end(String(error.message))
      );
      return;
    }
    if (url.startsWith("/model/")) {
      const file = decodeURIComponent(url.slice(7));
      download(file, accessToken).then(
        (body) => {
          res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
          measureFile(file, body);
        },
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
    evaluate,
    render: (model, gz) => evaluate(`render(${JSON.stringify(`/model/${encodeURIComponent(gz ? `${model}.gz` : model)}`)}, ${gz}, ${JSON.stringify(VIEW)})`, 600_000),
    reload: async () => {
      await call("Page.reload", {});
      await waitReady();
    },
    close: () => ws.close(),
  };
}

// From export.js (no view named): both views, the cards' then the match's
async function main(options = {}) {
  const view = options.view || argValue("--view");
  if (!view && require.main !== module) {
    await main({ view: "front" });
    return main({ view: "top" });
  }
  VIEW = view || "front";
  VIEW_DIR = VIEW === "front" ? "" : `${VIEW}/`;
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
  state.meta ??= {};
  const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

  const files = await modelList();
  const paths = new Set(files.map(([p]) => p));
  const models = files.filter(([p]) => p.endsWith(".glb") && !p.startsWith(PREFIX));
  const retry = process.argv.includes("--retry-failed");
  // Drawn models of this view: { model path: its size when drawn }
  const drawnKey = VIEW === "front" ? "done" : VIEW;
  state[drawnKey] ??= {};
  const only = argValue("--only")?.split(",");
  const todo = models
    .filter(([p]) => !only || only.includes(p))
    .filter(([p, size]) => state[drawnKey][p] !== size && (retry || state.failed[p] !== size))
    .slice(0, limit);
  const repo = upload ? await hf.prepareRepo(accessToken, DATASETS.models) : null;

  // Pictures (of this view) of models no longer in the dataset
  const gone = Object.keys(state[drawnKey]).filter((p) => !paths.has(p));
  if (gone.length && upload) {
    await hf.remove(repo, accessToken, gone.map(previewOf).filter((p) => paths.has(p)), "Remove previews of removed models");
    for (const p of gone) {
      delete state[drawnKey][p];
      if (VIEW === "front") delete state.meta[p];
    }
    saveState();
  }
  // Measures of models drawn before measures were kept
  if (process.argv.includes("--meta-only")) {
    const missing = models.filter(([p, size]) => state.meta[p]?.[0] !== size).slice(0, limit);
    console.log(`previews: ${missing.length} models to measure`);
    let next = 0;
    let count = 0;
    const worker = async () => {
      while (next < missing.length) {
        const [model, size] = missing[next++];
        const file = paths.has(`${model}.gz`) ? `${model}.gz` : model;
        try {
          await measureFile(file, await download(file, accessToken));
          if (measured.has(model)) state.meta[model] = [size, ...measured.get(model)];
          measured.delete(model);
        } catch (error) {
          console.log(`  ${model}: ${error.message}`);
        }
        if (++count % 500 === 0) {
          saveState();
          console.log(`  ${count}/${missing.length}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Number(argValue("--pages")) || 12 }, worker));
    saveState();
    return;
  }

  console.log(`previews: ${models.length} models, ${todo.length} to draw`);
  if (!todo.length) return;

  fs.mkdirSync(temp, { recursive: true });
  const server = await serve(accessToken);
  const { chrome, port } = await launchChrome();
  const pageUrl = `http://127.0.0.1:${server.address().port}/render.html?size=${SIZE}`;
  const pages = [];
  for (let i = 0; i < pageCount; i++) pages.push(await openPage(port, pageUrl));
  // The match view shows things in the colours the maps give them
  if (VIEW === "top") {
    const tints = JSON.stringify(await mapTints(accessToken));
    for (const page of pages) await page.evaluate(`setTints(${tints})`);
  }

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
      for (const b of batch) state[drawnKey][b.model] = b.size;
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
        if (measured.has(model)) state.meta[model] = [size, ...measured.get(model)];
        measured.delete(model);
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

module.exports = { main, serve, launchChrome, openPage };

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}
