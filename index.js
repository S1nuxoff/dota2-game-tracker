const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const vpk = require("vpk");
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const steam = require("./steam");
const hf = require("./hf");
const { externalRefs } = require("./resource");
const { writeVpk } = require("./vpk-writer");

const temp = "./temp";
const dirPath = `${temp}/pak01_dir.vpk`;
const packPath = `${temp}/models.vpk`;
const exportDir = `${temp}/export`;
const distDir = `${temp}/dist`;
// Per model: the game files it was exported from and a hash of their CRCs
const STATE_FILE = "state.json";
const ITEMS_URL =
  "https://raw.githubusercontent.com/S1nuxoff/dota2-file-tracker/main/static/items_game.json";
const HEROES_FILE = "scripts/npc/npc_heroes.txt";
const HERO_FILES = /^scripts\/npc\/heroes\/npc_dota_hero_\w+\.txt$/;
const DECOMPILER = "./vrf/Source2Viewer-CLI";

const BATCH_SIZE = 100;
const START_TIME = Date.now();
// GitHub stops a job after 6 hours, leave time to save the state
const MAX_DURATION = 5 * 3600 * 1000;

// Dependencies needed for a model with its materials, textures and animations.
// Particles, sounds and the rest are not part of a glTF export.
const FOLLOW = new Set([
  "vmdl",
  "vmesh",
  "vmat",
  "vtex",
  "vagrp",
  "vanim",
  "vseq",
  "vmorf",
  "vphys",
  "vnmskel",
  "vnmclip",
  "vnmgraph",
]);

async function main() {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const [username, password] = positional;
  const limit = Number(argValue("--limit")) || Infinity;
  const force = process.argv.includes("--force");
  const accessToken = process.env.HF_TOKEN;

  if (!username || !password || !accessToken) {
    console.error("Usage: HF_TOKEN=... node index.js <USERNAME> <PASSWORD> [--limit N] [--force]");
    process.exit(1);
  }

  const repo = await hf.prepareRepo(accessToken, process.env.HF_REPO);
  console.log(`Dataset: https://huggingface.co/datasets/${repo.name}`);

  await steam.logOn(username, password);
  const manifests = await steam.getManifests();

  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  await steam.downloadVpkDir(manifests, dirPath);
  const vpkDir = new vpk(dirPath);
  vpkDir.load();

  const items = await loadItems();
  const heroes = await loadHeroModels(vpkDir, manifests);
  const all = [...new Set([...Object.values(heroes), ...Object.values(items).flatMap((item) => item.models)])];
  const available = all.filter((model) => vpkDir.tree[`${model}_c`]);

  const state = loadState();
  const todo = available.filter((model) => force || hasChanged(state.models[model], vpkDir)).slice(0, limit);

  console.log(
    `${Object.keys(heroes).length} heroes, ${Object.keys(items).length} items, ` +
      `${all.length} models, ${all.length - available.length} not in the game files, ` +
      `${todo.length} to export in this run.`
  );

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    if (Date.now() - START_TIME >= MAX_DURATION) {
      console.log("Max duration reached, the rest is left for the next run.");
      break;
    }

    const batch = todo.slice(i, i + BATCH_SIZE);
    console.log(`\nBatch ${i / BATCH_SIZE + 1}/${Math.ceil(todo.length / BATCH_SIZE)}: ${batch.length} models`);
    const exported = await exportBatch(batch, vpkDir, manifests);

    const files = Object.keys(exported).map((model) => ({ path: glbPath(model), file: path.join(distDir, glbPath(model)) }));
    await hf.upload(repo, accessToken, files, `Export ${files.length} models`);

    for (const [model, deps] of Object.entries(exported)) {
      state.models[model] = { hash: depsHash(deps, vpkDir), deps };
    }
    saveState(state);
  }

  state.manifest = manifests[373301].manifestId;
  saveState(state);

  const indexFile = `${temp}/index.json`;
  fs.writeFileSync(indexFile, JSON.stringify(buildIndex(items, heroes, state), null, 1));
  await hf.upload(repo, accessToken, [{ path: "index.json", file: indexFile }], "Update index");
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// { id: { name, models } } for every item that has a model
async function loadItems() {
  console.log("Loading items_game.json");
  const res = await fetch(ITEMS_URL);
  if (!res.ok) {
    throw new Error(`Could not load items: HTTP ${res.status}`);
  }

  const items = {};
  for (const [id, item] of Object.entries((await res.json()).items_game.items)) {
    const models = modelsOf(item);
    if (models.length > 0) {
      items[id] = { name: item.name, models };
    }
  }
  return items;
}

// model_player for most wearables; couriers, wards and some arcanas set theirs in visuals
function modelsOf(item) {
  // modifier is not always a string, some asset modifiers hold an object
  const isModel = (value) => typeof value === "string" && value.endsWith(".vmdl");
  const models = new Set();
  if (isModel(item.model_player)) {
    models.add(item.model_player);
  }
  for (const [key, value] of Object.entries(item.visuals || {})) {
    if (key.startsWith("asset_modifier") && isModel(value?.modifier)) {
      models.add(value.modifier);
    }
  }
  return [...models];
}

// { npc_dota_hero_pudge: "models/heroes/pudge/pudge.vmdl", ... }
// npc_heroes.txt may only #base the per-hero files in scripts/npc/heroes/
async function loadHeroModels(vpkDir, manifests) {
  const paths = vpkDir.files.filter((file) => file === HEROES_FILE || HERO_FILES.test(file));
  const files = new Map();
  await steam.readFiles(vpkDir, dirPath, paths, manifests, files);

  const heroes = {};
  for (const content of files.values()) {
    let hero = null;
    for (const line of content.toString("utf8").split("\n")) {
      const heroKey = line.match(/^\s*"(npc_dota_hero_\w+)"\s*$/);
      if (heroKey) {
        hero = heroKey[1] === "npc_dota_hero_base" ? null : heroKey[1];
        continue;
      }
      const model = line.match(/^\s*"Model"\s+"([^"]+\.vmdl)"/i);
      if (hero && model && !heroes[hero]) {
        heroes[hero] = model[1].toLowerCase();
      }
    }
  }
  console.log(`Hero files: ${paths.length}, heroes with a model: ${Object.keys(heroes).length}`);
  return heroes;
}

function hasChanged(entry, vpkDir) {
  return !entry || entry.deps.some((file) => !vpkDir.tree[file]) || depsHash(entry.deps, vpkDir) !== entry.hash;
}

function depsHash(deps, vpkDir) {
  return zlib.crc32(deps.map((file) => `${file}:${vpkDir.tree[file].crc}`).join("\n")).toString(16);
}

// Returns { model: [game files it uses] } for the models that were exported
async function exportBatch(batch, vpkDir, manifests) {
  const files = new Map();
  await collect(batch, vpkDir, manifests, files);

  fs.rmSync(exportDir, { recursive: true, force: true });
  fs.rmSync(distDir, { recursive: true, force: true });
  writeVpk(packPath, files);
  runDecompiler(batch);

  // Without the extensions, gltf-transform drops data such as KHR_materials_specular
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const exported = {};
  for (const model of batch) {
    const glb = path.join(exportDir, glbPath(model));
    if (!fs.existsSync(glb)) {
      console.log(`Not exported: ${model}`);
      continue;
    }

    // Source2Viewer writes textures as separate PNGs, put them inside the GLB
    const target = path.join(distDir, glbPath(model));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await io.write(target, await io.read(glb));
    exported[model] = dependencies(`${model}_c`, files);
  }

  steam.clearChunkCache();
  console.log(`Exported ${Object.keys(exported).length}/${batch.length}, game files: ${files.size}`);
  return exported;
}

// Follows the dependencies of the models until nothing new comes up
async function collect(models, vpkDir, manifests, files) {
  const seen = new Set();
  let pending = models.map((model) => `${model}_c`);

  while (pending.length > 0) {
    const fresh = [...new Set(pending)].filter((file) => !seen.has(file) && vpkDir.tree[file]);
    fresh.forEach((file) => seen.add(file));
    await steam.readFiles(vpkDir, dirPath, fresh, manifests, files);
    pending = fresh.flatMap((file) => refsOf(files.get(file)));
  }
}

function dependencies(root, files) {
  const deps = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const file = stack.pop();
    if (deps.has(file) || !files.has(file)) {
      continue;
    }
    deps.add(file);
    stack.push(...refsOf(files.get(file)));
  }
  return [...deps].sort();
}

function refsOf(buffer) {
  return externalRefs(buffer)
    .filter((ref) => FOLLOW.has(ref.slice(ref.lastIndexOf(".") + 1).toLowerCase()))
    .map((ref) => `${ref.toLowerCase()}_c`);
}

function runDecompiler(models) {
  // With a filter matching exactly one file, -o is the output file, not a folder
  const output = models.length === 1 ? path.join(exportDir, glbPath(models[0])) : exportDir;
  const args = [
    "-i", packPath,
    "-f", models.map((model) => `${model}_c`).join(","),
    "-o", output,
    "-d",
    "--threads", "4",
    "--gltf_export_format", "glb",
    "--gltf_export_materials",
    "--gltf_export_animations",
  ];

  const result = spawnSync(DECOMPILER, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  const problems = `${result.stdout}${result.stderr}`
    .split("\n")
    .filter((line) => /fail|error|exception/i.test(line) && !line.includes('shader "'));
  for (const line of problems.slice(0, 20)) {
    console.log(`  ${line.trim()}`);
  }
}

function glbPath(model) {
  return model.replace(/\.vmdl$/, ".glb");
}

// What the viewer needs: which models show an item and a hero
function buildIndex(items, heroes, state) {
  const has = (model) => Boolean(state.models[model]);
  const index = { manifest: state.manifest, heroes: {}, items: {} };

  for (const [hero, model] of Object.entries(heroes)) {
    if (has(model)) {
      index.heroes[hero] = glbPath(model);
    }
  }
  for (const [id, item] of Object.entries(items)) {
    if (item.models.every(has)) {
      index.items[id] = { name: item.name, models: item.models.map(glbPath) };
    }
  }
  return index;
}

function loadState() {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  return { manifest: state.manifest ?? null, models: state.models ?? {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}

module.exports = { modelsOf, collect, exportBatch, dependencies, buildIndex, hasChanged };
