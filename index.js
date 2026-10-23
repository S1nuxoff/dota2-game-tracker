const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const hf = require("./hf");
const { steamSource, localSource } = require("./source");
const { exportSkins } = require("./skins");
const { exportDynamicMaterials, exportCubeMaps } = require("./materials");
const { readCloth, writeCloth, clothList } = require("./cloth");
const { readFlex, writeFlex, flexList } = require("./flex");
const { externalRefs } = require("./resource");
const { writeVpk } = require("./vpk-writer");
const { webGlb } = require("./web-glb");
const { parse } = require("./keyvalues");
const { summonsOf, UNITS_FILE } = require("./summons");

// Its own folder: other exports (sounds, scenes) run in ./temp next to it
const temp = "./temp/models";
const packPath = `${temp}/models.vpk`;
const exportDir = `${temp}/export`;
const distDir = `${temp}/dist`;
// Per model: the game files it was exported from and a hash of their CRCs
const STATE_FILE = "state.json";
const ITEMS_URL =
  "https://raw.githubusercontent.com/S1nuxoff/dota2-file-tracker/main/static/items_game.json";
const HEROES_FILE = "scripts/npc/npc_heroes.txt";
const HERO_FILES = /^scripts\/npc\/heroes\/npc_dota_hero_\w+\.txt$/;
// What each hero stands on in its page's scene
const LOADOUT_PORTRAITS = "scripts/npc/portraits_full_body_loadout.txt";
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
const THREADS = String(Math.max(2, os.cpus().length - 1));

const BATCH_SIZE = 100;
const START_TIME = Date.now();
// GitHub stops a job after 6 hours, leave time to save the state
const CI_MAX_DURATION = 5 * 3600 * 1000;

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

const USAGE = `Usage:
  HF_TOKEN=... node index.js <STEAM USERNAME> <STEAM PASSWORD> [options]   download from Steam
  HF_TOKEN=... node index.js --game "<...>/dota 2 beta/game/dota" [options] read a local install

Options:
  --limit N      export at most N models
  --hero NAME    only this hero and its items, e.g. --hero pudge
  --force        export again models whose game files did not change`;

async function main() {
  const positional = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith("--") && !args[index - 1]?.match(/^--(limit|hero|game)$/));
  const game = argValue("--game");
  const limit = Number(argValue("--limit")) || Infinity;
  const onlyHero = argValue("--hero");
  const force = process.argv.includes("--force");
  const accessToken = process.env.HF_TOKEN;

  if (!accessToken || (!game && positional.length < 2)) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!fs.existsSync(DECOMPILER)) {
    throw new Error(`${DECOMPILER} not found, put Source2Viewer-CLI in ./vrf`);
  }

  const repo = await hf.prepareRepo(accessToken, process.env.HF_REPO);
  console.log(`Dataset: https://huggingface.co/datasets/${repo.name}`);

  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const source = game ? localSource(game) : await steamSource(positional[0], positional[1], temp);
  const { vpkDir } = source;
  const maxDuration = game ? Infinity : CI_MAX_DURATION;

  const { items, heroSkins } = await loadItems();
  const { heroes, personas } = await loadHeroModels(source);
  const pedestals = await loadPedestals(source);
  // The models particle effects draw, as listed by particles.js
  const particleModels = !onlyHero && fs.existsSync("particle-models.json") ? JSON.parse(fs.readFileSync("particle-models.json", "utf8")) : [];

  // Heroes and what they wear by default first, so heroes show up complete early on
  const forHero = (item) => !onlyHero || item.heroes.includes(`npc_dota_hero_${onlyHero}`);
  // Every model an item can show: its default ones and those of its styles
  const modelsWhere = (filter) =>
    Object.values(items)
      .filter((item) => forHero(item) && filter(item))
      .flatMap((item) => [...item.models, ...(item.styles ?? []).flatMap((style) => style.models), ...(item.swaps ?? []).map(([, to]) => to)]);
  const all = [
    ...new Set([
      ...Object.entries(heroes)
        .filter(([key]) => !onlyHero || key === `npc_dota_hero_${onlyHero}`)
        .map(([, model]) => model),
      ...Object.entries(personas)
        .filter(([key]) => !onlyHero || key === `npc_dota_hero_${onlyHero}`)
        .flatMap(([, models]) => models),
      ...pedestals,
      ...particleModels,
      ...modelsWhere((item) => item.prefab === "default_item"),
      ...modelsWhere((item) => item.prefab !== "default_item"),
    ]),
  ];
  const available = all.filter((model) => vpkDir.tree[`${model}_c`]);
  const wantedSkins = skinsWanted(items);
  // The skins items give the hero's own model (model_skin: Legion Commander's Arcana, skin 1)
  for (const { heroes: keys, skin } of heroSkins) {
    for (const key of keys) {
      const model = heroes[key];
      if (!model) continue;
      if (!wantedSkins.has(model)) wantedSkins.set(model, new Set());
      wantedSkins.get(model).add(skin);
    }
  }

  const skinsKey = (model) => [...(wantedSkins.get(model) ?? [])].sort().join(",");
  const state = loadState();
  // --force: the materials' dynamic parameters and cube maps again too
  if (force) {
    delete state.dynamicMaterials;
    delete state.cubeMaps;
  }
  // Models the converter failed on are tried again once their file changes
  const failedBefore = (model) => state.failed[model] === vpkDir.tree[`${model}_c`].crc;
  const todo = available
    .filter(
      (model) =>
        force ||
        (hasChanged(state.models[model], vpkDir) && !failedBefore(model)) ||
        // A model exported before an item asked for its skins (once: skinsRead keeps those read,
        // a model without such a material group has no skins file to show for it)
        (wantedSkins.has(model) &&
          state.models[model] &&
          !state.models[model].skins &&
          state.models[model].skinsRead !== skinsKey(model))
    )
    .slice(0, limit);

  console.log(
    `${Object.keys(heroes).length} heroes, ${Object.keys(items).length} items, ` +
      `${all.length} models${onlyHero ? ` for ${onlyHero}` : ""}, ${all.length - available.length} not in the game files, ` +
      `${todo.length} to export in this run.`
  );

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    if (Date.now() - START_TIME >= maxDuration) {
      console.log("Max duration reached, the rest is left for the next run.");
      break;
    }

    const batch = todo.slice(i, i + BATCH_SIZE);
    console.log(`\nBatch ${i / BATCH_SIZE + 1}/${Math.ceil(todo.length / BATCH_SIZE)}: ${batch.length} models`);
    const { exported, skins, cloth, clothFiles, flex, flexFiles } = await exportBatch(batch, source, wantedSkins);

    // Textures of material variants are shared, each is uploaded once
    const newTextures = skins.textures.filter((texture) => !state.textures[texture.path]);
    const files = [
      ...Object.keys(exported).flatMap((model) => [
        { path: glbPath(model), file: path.join(distDir, glbPath(model)) },
        { path: `${glbPath(model)}.gz`, file: path.join(distDir, `${glbPath(model)}.gz`) },
      ]),
      ...skins.json,
      ...newTextures,
      ...clothFiles,
      ...flexFiles,
    ];
    await hf.upload(repo, accessToken, files, `Export ${Object.keys(exported).length} models`);

    for (const [model, deps] of Object.entries(exported)) {
      state.models[model] = { hash: depsHash(deps, vpkDir), deps, cloth: Boolean(cloth[model]), flex: Boolean(flex[model]) };
      if (wantedSkins.has(model)) state.models[model].skinsRead = skinsKey(model);
      delete state.failed[model];
    }
    for (const model of batch.filter((model) => !exported[model])) {
      state.failed[model] = vpkDir.tree[`${model}_c`].crc;
    }
    for (const { path: datasetPath } of skins.json) {
      state.models[datasetPath.replace(/\.skins\.json$/, ".vmdl")].skins = true;
    }
    for (const texture of newTextures) {
      state.textures[texture.path] = true;
    }
    saveState(state);
    source.release();
    // The viewer reads the index, so models show up there batch by batch
    await uploadIndex(repo, accessToken, items, heroes, state, personas);

    const done = Math.min(i + BATCH_SIZE, todo.length);
    const minutes = (Date.now() - START_TIME) / 60000;
    const left = (minutes / done) * (todo.length - done);
    console.log(
      `Progress: ${done}/${todo.length} models (${Math.round((done / todo.length) * 100)}%), ` +
        `${Math.round(minutes)} min so far, about ${left >= 60 ? `${(left / 60).toFixed(1)} h` : `${Math.round(left)} min`} left`
    );
  }

  // The parameters of the models' materials that change as the game runs
  const dynamic = await exportDynamicMaterials({ state, source, decompiler: DECOMPILER, temp });
  if (dynamic) {
    await hf.upload(repo, accessToken, [dynamic.upload], "Dynamic material parameters");
    state.dynamicMaterials = dynamic.hash;
  }
  // The cube maps the materials reflect, all six faces
  const cubeMaps = await exportCubeMaps({ state, source, decompiler: DECOMPILER, temp });
  if (cubeMaps) {
    await hf.upload(repo, accessToken, cubeMaps.uploads, "Cube maps");
    state.cubeMaps = cubeMaps.record;
  }

  state.manifest = source.manifestId ?? state.manifest;
  saveState(state);
  await uploadIndex(repo, accessToken, items, heroes, state, personas);
}

async function uploadIndex(repo, accessToken, items, heroes, state, personas) {
  const index = buildIndex(items, heroes, state, personas);
  const indexFile = `${temp}/index.json`;
  // The viewer checks this small list for new models, not the whole index
  const exportedFile = `${temp}/exported.json`;
  fs.writeFileSync(indexFile, JSON.stringify(index));
  fs.writeFileSync(exportedFile, JSON.stringify(index.exported));
  await hf.upload(
    repo,
    accessToken,
    [
      { path: "index.json", file: indexFile },
      { path: "exported.json", file: exportedFile },
      // The models whose cloth, hair and beards move (cloth.js)
      clothList(state, temp),
      // The models whose faces move as they speak (flex.js)
      flexList(state, temp),
    ],
    "Update index"
  );
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// items: { id: { name, prefab, heroes, models, skin?, styles? } } for every item that has a model;
// heroSkins: [{ heroes, skin }] the skins items put on their hero's own model (model_skin)
async function loadItems() {
  // An items_game.json next to the script is used instead of downloading it
  let data;
  if (fs.existsSync("items_game.json")) {
    console.log("Reading items_game.json");
    data = JSON.parse(fs.readFileSync("items_game.json", "utf8"));
  } else {
    console.log("Loading items_game.json");
    const res = await fetch(ITEMS_URL);
    if (!res.ok) {
      throw new Error(`Could not load items: HTTP ${res.status}`);
    }
    data = await res.json();
  }

  const items = {};
  const heroSkins = [];
  for (const [id, item] of Object.entries(data.items_game.items)) {
    for (const [key, value] of Object.entries(item.visuals ?? {})) {
      if (key.startsWith("asset_modifier") && value?.type === "model_skin" && Number(value.skin)) {
        heroSkins.push({ heroes: Object.keys(item.used_by_heroes ?? {}), skin: Number(value.skin) });
      }
    }
    const models = modelsOf(item);
    const swaps = swapsOf(item);
    if (models.length > 0 || swaps.length > 0) {
      items[id] = {
        name: item.name,
        prefab: item.prefab,
        heroes: Object.keys(item.used_by_heroes ?? {}),
        models,
        ...stylesOf(item, models),
        ...(swaps.length && { swaps }),
      };
    }
  }
  return { items, heroSkins };
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
    // A "model" modifier puts its model in place of another one the hero wears (swapsOf)
    if (key.startsWith("asset_modifier") && isModel(value?.modifier) && value.type !== "model") {
      models.add(value.modifier);
    }
  }
  return [...models];
}

// The models an item puts in place of others the hero wears ("model" modifiers: Blades of Voth
// Domosh's swords for Legion Commander's weapons, an arcana's look of the hero's other items):
// [[the model worn, the model shown instead, style?]], the style when only one of its styles does
function swapsOf(item) {
  const isModel = (value) => typeof value === "string" && value.endsWith(".vmdl");
  const swaps = [];
  for (const [key, value] of Object.entries(item.visuals || {})) {
    if (!key.startsWith("asset_modifier") || value?.type !== "model" || !isModel(value.asset) || !isModel(value.modifier)) continue;
    const [from, to] = [value.asset.toLowerCase(), value.modifier.toLowerCase()];
    if (from === to) continue;
    swaps.push(value.style !== undefined ? [from, to, Number(value.style)] : [from, to]);
  }
  return swaps;
}

// Styles change the material (a skin of the model) and sometimes the model itself:
// { skin, styles: [{ models, skin }] } with the models each style shows
function stylesOf(item, models) {
  const visuals = item.visuals ?? {};
  const isModel = (value) => typeof value === "string" && value.endsWith(".vmdl");
  const result = {};
  if (visuals.skin !== undefined) {
    result.skin = Number(visuals.skin);
  }
  const styles = Object.entries(visuals.styles ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  if (styles.length > 1) {
    result.styles = styles.map(([, style]) => {
      const own = isModel(style.model_player) ? style.model_player : null;
      return {
        // A style's model replaces the item's own model_player, other models stay
        models: own ? [own, ...models.filter((model) => model !== item.model_player)] : models,
        skin: style.skin !== undefined ? Number(style.skin) : (result.skin ?? 0),
      };
    });
  }
  return result;
}

// Model -> the skins (material groups other than the default) items show it with
function skinsWanted(items) {
  const wanted = new Map();
  const add = (models, skin) => {
    if (!skin) {
      return;
    }
    for (const model of models) {
      if (!wanted.has(model)) {
        wanted.set(model, new Set());
      }
      wanted.get(model).add(skin);
    }
  };
  for (const item of Object.values(items)) {
    add(item.models, item.skin);
    for (const style of item.styles ?? []) {
      add(style.models, style.skin);
    }
  }
  return wanted;
}

// { heroes: { npc_dota_hero_pudge: "models/heroes/pudge/pudge.vmdl", ... }, personas: { hero: [model, ...] } }
// Personas are a hero's other bodies (the female Anti-Mage), the Model lines after the first.
// The pedestals the heroes stand on in their pages' scenes, from the loadout portraits, and the
// models of the units beside them there (summons.js)
async function loadPedestals(source) {
  if (!source.vpkDir.tree[LOADOUT_PORTRAITS]) {
    return [];
  }
  const files = new Map();
  await source.readFiles([LOADOUT_PORTRAITS, ...(source.vpkDir.tree[UNITS_FILE] ? [UNITS_FILE] : [])], files);
  const text = files.get(LOADOUT_PORTRAITS).toString("utf8");
  const pedestals = [...text.matchAll(/"PortraitBackgroundModel"\s+"([^"]+\.vmdl)"/gi)].map((match) => match[1].toLowerCase());
  const units = files.has(UNITS_FILE) ? parse(files.get(UNITS_FILE)).root.DOTAUnits ?? {} : {};
  const portraits = parse(files.get(LOADOUT_PORTRAITS)).root.DOTAFullBodyLoadoutPortraitInfo ?? {};
  const summons = Object.values(portraits).flatMap((entry) => summonsOf(entry, units).map((summon) => summon.model.replace(/\.glb$/, ".vmdl")));
  return [...new Set([...pedestals, ...summons])];
}

// npc_heroes.txt may only #base the per-hero files in scripts/npc/heroes/
async function loadHeroModels(source) {
  const paths = source.vpkDir.files.filter((file) => file === HEROES_FILE || HERO_FILES.test(file));
  const files = new Map();
  await source.readFiles(paths, files);

  const heroes = {};
  const personas = {};
  for (const content of files.values()) {
    let hero = null;
    let inPersona = false;
    for (const line of content.toString("utf8").split("\n")) {
      const heroKey = line.match(/^\s*"(npc_dota_hero_\w+)"\s*$/);
      if (heroKey) {
        hero = heroKey[1] === "npc_dota_hero_base" ? null : heroKey[1];
        continue;
      }
      // A hero's Persona block gives the persona's model
      if (/^\s*"Persona"\s*$/.test(line)) {
        inPersona = true;
        continue;
      }
      const model = line.match(/^\s*"Model"\s+"([^"]+\.vmdl)"/i);
      if (hero && model && !heroes[hero]) {
        heroes[hero] = model[1].toLowerCase();
      } else if (hero && model && inPersona) {
        (personas[hero] ??= []).push(model[1].toLowerCase());
        inPersona = false;
      }
    }
  }
  console.log(`Hero files: ${paths.length}, heroes with a model: ${Object.keys(heroes).length}, with personas: ${Object.keys(personas).length}`);
  return { heroes, personas };
}

function hasChanged(entry, vpkDir) {
  return !entry || entry.deps.some((file) => !vpkDir.tree[file]) || depsHash(entry.deps, vpkDir) !== entry.hash;
}

function depsHash(deps, vpkDir) {
  return zlib.crc32(deps.map((file) => `${file}:${vpkDir.tree[file].crc}`).join("\n")).toString(16);
}

// Returns { exported: { model: [game files it uses] }, skins: { json, textures } }
async function exportBatch(batch, source, wantedSkins) {
  const files = new Map();
  const collectMore = (paths) => collect(paths.map((file) => file.replace(/_c$/, "")), source, files);
  await collect(batch, source, files);

  fs.rmSync(exportDir, { recursive: true, force: true });
  fs.rmSync(distDir, { recursive: true, force: true });
  // A local install is given to the converter whole, so it finds everything a model
  // needs (also from core); from Steam it gets a pack of the files collected above
  if (!source.gameDir) {
    writeVpk(packPath, files);
  }
  const input = source.gameDir ? path.join(source.gameDir, "pak01_dir.vpk") : packPath;
  runDecompiler(batch, input);
  // Source2Viewer fails on some animation data; such models are exported without animations
  const failed = batch.filter((model) => !fs.existsSync(path.join(exportDir, glbPath(model))));
  if (failed.length > 0) {
    console.log(`Trying ${failed.length} models again without animations`);
    runDecompiler(failed, input, false);
  }

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
    const document = await io.read(glb);
    await io.write(target, document);
    // The site's lighter copy next to it (web-glb.js)
    fs.writeFileSync(`${target}.gz`, await webGlb(io, document));
    exported[model] = dependencies(`${model}_c`, files);
  }

  const wanted = new Map(Object.keys(exported).filter((model) => wantedSkins.has(model)).map((model) => [model, wantedSkins.get(model)]));
  const skins = wanted.size
    ? await exportSkins({ wanted, files, collect: collectMore, decompiler: DECOMPILER, temp, distDir })
    : { json: [], textures: [] };

  // Cloth, hair and beards the game moves, from the models' physics
  const cloth = readCloth(new Map(Object.keys(exported).map((model) => [`${model}_c`, files.get(`${model}_c`)])), DECOMPILER, `${temp}/cloth`);
  const clothFiles = writeCloth(cloth, distDir);
  // The flex controllers and rules that move the faces' morph targets
  const flex = readFlex(new Map(Object.keys(exported).map((model) => [`${model}_c`, files.get(`${model}_c`)])), DECOMPILER, `${temp}/flex`);
  const flexFiles = writeFlex(flex, distDir);

  console.log(
    `Exported ${Object.keys(exported).length}/${batch.length}, game files: ${files.size}` +
      (wanted.size ? `, material variants for ${skins.json.length} models, ${skins.textures.length} textures` : "") +
      (clothFiles.length ? `, cloth of ${clothFiles.length}` : "") +
      (flexFiles.length ? `, flex of ${flexFiles.length}` : "")
  );
  return { exported, skins, cloth, clothFiles, flex, flexFiles };
}

// Follows the dependencies of the models (paths without the _c of compiled files)
// until nothing new comes up, skipping what files already holds
async function collect(models, source, files) {
  const seen = new Set(files.keys());
  let pending = models.map((model) => `${model}_c`);

  while (pending.length > 0) {
    const fresh = [...new Set(pending)].filter((file) => !seen.has(file) && source.vpkDir.tree[file]);
    fresh.forEach((file) => seen.add(file));
    await source.readFiles(fresh, files);
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

function runDecompiler(models, input, animations = true) {
  // With a filter matching exactly one file, -o is the output file, not a folder
  const output = models.length === 1 ? path.join(exportDir, glbPath(models[0])) : exportDir;
  const args = [
    "-i", input,
    "-f", models.map((model) => `${model}_c`).join(","),
    "-o", output,
    "-d",
    "--threads", THREADS,
    "--gltf_export_format", "glb",
    "--gltf_export_materials",
    ...(animations ? ["--gltf_export_animations"] : []),
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

// What the viewer needs: which models show each hero and item, which of them are
// exported so far, and which have material variants
function buildIndex(items, heroes, state, personas = {}) {
  const index = {
    manifest: state.manifest,
    updated: new Date().toISOString(),
    heroes: {},
    personas: {},
    items: {},
    exported: Object.keys(state.models).map(glbPath).sort(),
    skins: Object.keys(state.models).filter((model) => state.models[model].skins).map(glbPath).sort(),
  };
  for (const [hero, model] of Object.entries(heroes)) {
    index.heroes[hero] = glbPath(model);
  }
  for (const [hero, models] of Object.entries(personas)) {
    index.personas[hero] = models.map(glbPath);
  }
  for (const [id, item] of Object.entries(items)) {
    index.items[id] = {
      name: item.name,
      models: item.models.map(glbPath),
      ...(item.skin !== undefined && { skin: item.skin }),
      ...(item.styles && { styles: item.styles.map((style) => ({ models: style.models.map(glbPath), skin: style.skin })) }),
      ...(item.swaps && { swaps: item.swaps.map(([from, to, style]) => [glbPath(from), glbPath(to), ...(style !== undefined ? [style] : [])]) }),
    };
  }
  return index;
}

function loadState() {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  return { manifest: state.manifest ?? null, models: state.models ?? {}, textures: state.textures ?? {}, failed: state.failed ?? {}, dynamicMaterials: state.dynamicMaterials ?? null, cubeMaps: state.cubeMaps ?? null };
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

module.exports = { modelsOf, swapsOf, stylesOf, skinsWanted, collect, exportBatch, dependencies, buildIndex, hasChanged };
