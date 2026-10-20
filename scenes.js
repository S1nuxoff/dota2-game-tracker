// Scenes and maps of the game as glTF: MVP showcases, treasure openings, main menu
// backgrounds, event and battle pass scenes, and the game's maps, each a .glb with its
// textures inside. Only scenes whose files changed are exported again (scenes-state.json, by
// the SHA-1 of each package).
//
//   HF_TOKEN=... node scenes.js --game "<...>/dota 2 beta/game/dota" [--only mvp] [--limit N] [--max-minutes N] [--no-upload] [--info]
//   HF_TOKEN=... node scenes.js <STEAM USERNAME> <STEAM PASSWORD> [--max-minutes N]   (GitHub Actions)
//   --info reads the lights and cameras of the scenes already exported again (local install)
//   --max-minutes stops starting new scenes after that long; the rest go next time
//
// Uploads to the <user>/dota2-scenes dataset: scenes/<path>.glb and scenes.json
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const vpk = require("vpk");
const hf = require("./hf");
const { localSource, steamSource } = require("./source");
const { writeVpk } = require("./vpk-writer");
const { externalRefs } = require("./resource");

const temp = "./temp/scenes";
const STATE_FILE = "scenes-state.json";
// A batch of scenes goes up once it holds this much, or after this long
const BATCH_BYTES = 500 * 1e6;
const BATCH_MS = 10 * 60 * 1000;
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(args) {
  const result = spawnSync(DECOMPILER, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  return `${result.stdout}${result.stderr}`;
}

// "scenes/mvp/mvp_pudge_arcana" -> "Mvp Pudge Arcana"
function sceneName(id) {
  return id
    .split("/")
    .pop()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// A cheap fingerprint of a scene package: its size and modification time
function fingerprint(file) {
  const stat = fs.statSync(file);
  return zlib.crc32(`${stat.size}:${stat.mtimeMs}`).toString(16);
}

// Source is Z-up, the glTF files Source2Viewer writes Y-up: (x, y, z) -> (y, z, x)
function toGltfAxes([x, y, z]) {
  return [y, z, x];
}

// A point of the game, in inches, as a point of the glTF, in metres
function toGltf(point) {
  return toGltfAxes(point).map((value) => Number((value * 0.0254).toFixed(4)));
}

// The way Source angles [pitch, yaw, roll] face, in glTF axes
function forward([pitch, yaw]) {
  const p = (pitch * Math.PI) / 180;
  const y = (yaw * Math.PI) / 180;
  return toGltfAxes([Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)]).map((value) => Number(value.toFixed(4)));
}

// The camera and light the game's interface shows each scene with, from its Panorama layouts:
// <DOTAScenePanel map="backgrounds/hero_showcase_antimage_persona" camera="herocamera" light="light_hero">.
// { "backgrounds/hero_showcase_antimage_persona": { camera: "herocamera", light: "light_hero" } };
// where layouts name different cameras for one map, the one named most often.
async function layoutLooks(source) {
  const layouts = source.vpkDir.files.filter((file) => /^panorama\/layout\/.*\.vxml_c$/.test(file));
  const files = new Map();
  await source.readFiles(layouts, files);
  const work = path.join(temp, "layouts");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  writeVpk(path.join(work, "layouts.vpk"), files);
  run(["-i", path.join(work, "layouts.vpk"), "-o", path.join(work, "out"), "-d"]);
  const counts = {};
  const xmls = fs.readdirSync(path.join(work, "out"), { recursive: true }).filter((file) => file.endsWith(".xml"));
  for (const xml of xmls) {
    const text = fs.readFileSync(path.join(work, "out", xml), "utf8");
    for (const [panel] of text.matchAll(/<DOTAScenePanel\b[^>]*>/g)) {
      const attribute = (name) => panel.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
      const map = attribute("map")?.toLowerCase().replace(/^maps\//, "").replace(/\.vmap$/, "");
      if (!map) {
        continue;
      }
      const key = `${attribute("camera") ?? ""}\n${attribute("light") ?? ""}`;
      counts[map] ??= {};
      counts[map][key] = (counts[map][key] ?? 0) + 1;
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  const looks = {};
  for (const [map, keys] of Object.entries(counts)) {
    // A panel that names a camera before one that leaves it to the map
    const [camera, light] = Object.entries(keys)
      .sort((a, b) => Boolean(b[0].split("\n")[0]) - Boolean(a[0].split("\n")[0]) || b[1] - a[1])[0][0]
      .split("\n");
    looks[map] = { shown: true, camera: camera || undefined, light: light || undefined };
  }
  console.log(`${xmls.length} interface layouts, ${Object.keys(looks).length} scenes shown in them`);
  return looks;
}

// An entity's name without the prefix of the prefab it came from: "[PR#]herocamera" -> "herocamera"
const entityName = (entity) => (entity.targetname ?? "").replace(/^\[[^\]]*\]/, "").toLowerCase();

// What the viewer needs to light a scene and look at it the way the game does: the global light,
// its ambient colors, the scene's cameras and the one the game shows it with, and the point lights.
// look: the camera and light the game's interface names for the scene (layoutLooks), if any.
function sceneInfo(file, look = {}) {
  const entities = [];
  // Source2Viewer writes the lumps out as text in one way for both of their formats (older maps
  // keep their keys hashed): "====0====" before each entity, then a key and its value a line
  const out = path.join(temp, "entities.txt");
  for (const lump of run(["-i", file, "-l"]).match(/^\S+\.vents_c/gm) ?? []) {
    fs.rmSync(out, { force: true });
    run(["-i", file, "-f", lump, "-o", out, "-d"]);
    if (!fs.existsSync(out)) {
      continue;
    }
    for (const body of fs.readFileSync(out, "utf8").split(/^====\d+====\r?$/m).slice(1)) {
      const entity = {};
      for (const [, key, value] of body.matchAll(/^(\S+)[ \t]+(.+?)\r?$/gm)) {
        entity[key.toLowerCase()] = value.startsWith('"')
          ? value.slice(1, -1)
          : value.startsWith("[")
            ? value.slice(1, -1).split(",").map(Number)
            : value === "true" || value === "false"
              ? value === "true"
              : Number(value);
      }
      entities.push(entity);
    }
  }
  fs.rmSync(out, { force: true });
  const numbers = (text) => (typeof text === "string" ? text.split(" ").map(Number) : [0, 0, 0]);
  // Older maps keep colors as text, "255 240 200 255"
  const rgb = (value, scale = 1) => {
    const parts = typeof value === "string" ? value.trim().split(/s+/).map(Number) : value;
    return Array.isArray(parts) && parts.length >= 3 ? parts.slice(0, 3).map((part) => Number(((part / 255) * Number(scale)).toFixed(3))) : undefined;
  };
  const info = {};
  const suns = entities.filter((entity) => entity.classname === "env_global_light");
  const sun = suns.find((entity) => look.light && entityName(entity) === look.light.toLowerCase()) ?? suns[0];
  if (sun) {
    info.light = {
      color: rgb(sun.color, sun.lightscale ?? 1),
      direction: forward(numbers(sun.angles)),
      ambient: [rgb(sun.ambientcolor1, sun.ambientscale1 ?? 1), rgb(sun.ambientcolor2, sun.ambientscale2 ?? 1), rgb(sun.ambientcolor3, sun.ambientscale3 ?? 1)],
    };
  }
  // Every named camera of the scene, and the one the game's interface looks through; a scene
  // the interface does not show keeps its first named camera
  const cameras = {};
  for (const entity of entities.filter((entity) => entity.classname === "point_camera" && entityName(entity))) {
    cameras[entityName(entity)] ??= { position: toGltf(numbers(entity.origin)), direction: forward(numbers(entity.angles)), fov: Number(entity.fov ?? 30) };
  }
  const names = Object.keys(cameras);
  const chosen = cameras[look.camera?.toLowerCase()] ? look.camera.toLowerCase() : names[0];
  if (names.length) {
    info.cameras = cameras;
  }
  if (chosen) {
    info.camera = { name: chosen, ...cameras[chosen] };
  }
  // What the map is for, as its world says ("background", "game", ...), and whether the game's
  // interface shows it
  const world = entities.find((entity) => entity.classname === "worldspawn");
  if (world?.mapusagetype) {
    info.usage = world.mapusagetype;
  }
  if (look.shown) {
    info.shown = true;
  }
  const fog = entities.find((entity) => entity.classname === "env_fog_controller");
  if (fog && rgb(fog.fogcolor)) {
    info.fog = { color: rgb(fog.fogcolor), start: Number(fog.fogstart) || 0, end: Number(fog.fogend) || 4000, max: Number(fog.fogmaxdensity ?? 1) };
  }
  const points = entities
    .filter((entity) => entity.classname === "env_deferred_light" || entity.classname === "light_omni")
    .map((entity) => ({ position: toGltf(numbers(entity.origin)), color: rgb(entity.lightcolor ?? entity.color, entity.intensity ?? entity.brightness ?? 1) }))
    .filter((point) => point.color);
  if (points.length) {
    info.points = points;
  }
  return info;
}

// The game's files a scene needs besides its own package, for the converter: models, meshes,
// materials and textures its world and props name, followed until nothing new comes up
const FOLLOW = new Set(["vmdl", "vmesh", "vmat", "vtex", "vagrp", "vanim", "vseq", "vmorf", "vphys", "vnmskel", "vnmclip", "vnmgraph"]);
async function collectScene(files, source) {
  const seen = new Set(files.keys());
  let pending = [...files.values()].flatMap(refsOf);
  while (pending.length > 0) {
    const fresh = [...new Set(pending)].filter((file) => !seen.has(file) && source.vpkDir.tree[file]);
    fresh.forEach((file) => seen.add(file));
    await source.readFiles(fresh, files);
    pending = fresh.flatMap((file) => refsOf(files.get(file)));
  }
}
function refsOf(buffer) {
  return externalRefs(buffer)
    .filter((ref) => FOLLOW.has(ref.slice(ref.lastIndexOf(".") + 1).toLowerCase()))
    .map((ref) => `${ref.toLowerCase()}_c`);
}

async function main() {
  const game = argValue("--game");
  const [username, password] = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith("--") && !["--game", "--only", "--limit", "--max-minutes"].includes(args[index - 1]));
  const only = argValue("--only");
  const limit = Number(argValue("--limit")) || Infinity;
  const maxMinutes = Number(argValue("--max-minutes")) || Infinity;
  const upload = !process.argv.includes("--no-upload");
  if ((!game && !password) || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node scenes.js --game "<...>/dota 2 beta/game/dota" | <STEAM USERNAME> <STEAM PASSWORD> [--only <folder>] [--limit N] [--max-minutes N] [--no-upload] [--info]');
    process.exit(1);
  }
  fs.mkdirSync(temp, { recursive: true });
  const source = game ? localSource(game) : await steamSource(username, password, temp);

  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { scenes: {} };
  // The map packages, loose files of the game (from a local install or Steam's depots), by the
  // SHA-1 of their content
  const packages = source
    .looseFiles("maps/")
    .filter((entry) => entry.path.endsWith(".vpk") && !/_\d{3}\.vpk$/.test(entry.path))
    .map((entry) => ({ entry, sha: entry.sha, id: entry.path.replace(/^maps\//, "").replace(/\.vpk$/, "") }))
    .sort((a, b) => a.id.localeCompare(b.id));
  // Scenes exported before the SHA-1 was kept: taken as they are when the local file is the one
  // exported (its size and time as then)
  if (source.gameDir) {
    for (const scene of packages) {
      const kept = state.scenes[scene.id];
      if (kept && !kept.sha && kept.fingerprint === fingerprint(scene.entry.file)) {
        kept.sha = scene.sha;
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  }
  // SCENES_PACK=1 builds the pack as from Steam even from a local install (to test that path)
  const packed = !source.gameDir || process.env.SCENES_PACK === "1";
  const todo = packages
    .filter((scene) => !only || scene.id.startsWith(only))
    // --force: every scene again
    .filter((scene) => process.argv.includes("--force") || process.env.SCENES_PACK === "1" || state.scenes[scene.id]?.sha !== scene.sha)
    .slice(0, limit);
  console.log(`${packages.length} scenes and maps, ${todo.length} to export.`);

  const info = process.argv.includes("--info") && source.gameDir;
  // The cameras and lights the game shows the scenes with, read when a scene is to be looked at
  const looks = todo.length || info ? await layoutLooks(source) : {};
  if (info) {
    for (const scene of packages) {
      if (state.scenes[scene.id] && !state.scenes[scene.id].empty) {
        state.scenes[scene.id].info = sceneInfo(scene.entry.file, looks[scene.id]);
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  }

  const repo = upload ? await hf.prepareRepo(process.env.HF_TOKEN, process.env.HF_SCENES_REPO || "dota2-scenes") : null;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const started = Date.now();
  // Scenes go up a batch at a time, one commit each: the Hub takes 128 commits an hour to a
  // repository, and a run exports hundreds of scenes, many of them tiny. A scene counts as done
  // only once its batch is up.
  let batch = [];
  let batchBytes = 0;
  let batchStarted = Date.now();
  const flush = async () => {
    if (batch.length === 0) {
      return;
    }
    if (upload) {
      await hf.upload(repo, process.env.HF_TOKEN, batch.map(({ id, file }) => ({ path: `scenes/${id}.glb`, file })), `Scenes: ${batch.length}`);
    }
    for (const { id, record, file } of batch) {
      state.scenes[id] = record;
      fs.rmSync(file, { force: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
    batch = [];
    batchBytes = 0;
    batchStarted = Date.now();
  };

  for (const [index, scene] of todo.entries()) {
    if ((Date.now() - started) / 60000 > maxMinutes) {
      console.log(`Time is up after ${index} scenes; the rest go next time`);
      break;
    }
    const out = path.join(temp, "export");
    fs.rmSync(out, { recursive: true, force: true });
    // The package itself: the install's file, or downloaded from Steam
    let file = scene.entry.file;
    let input = file;
    if (packed) {
      file = path.join(temp, "package", path.basename(scene.entry.path));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, await source.readLoose(scene.entry));
    }
    // The package's map, e.g. maps/scenes/mvp/mvp_default.vmap_c
    const listing = run(["-i", file, "-l"]);
    const vmap = listing.match(/^(\S+\.vmap_c)/m)?.[1];
    if (!vmap) {
      console.log(`${scene.id}: no map inside`);
      state.scenes[scene.id] = { sha: scene.sha, empty: true };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
      continue;
    }
    // From Steam the converter cannot look in the install for what the map uses: the package's
    // files and what they name from the game's VPKs go in one pack
    if (packed) {
      const pack = new vpk(file);
      pack.load();
      const files = new Map(pack.files.map((name) => [name.toLowerCase(), pack.getFile(name)]).filter(([, data]) => data));
      await collectScene(files, source);
      input = path.join(temp, "package", "scene.vpk");
      writeVpk(input, files);
      source.release();
    }

    run(["-i", input, "-f", vmap, "-o", path.join(out, "scene.glb"), "-d", "--gltf_export_format", "glb", "--gltf_export_materials"]);
    const glb = path.join(out, "scene.glb");
    if (!fs.existsSync(glb)) {
      console.log(`${scene.id}: not exported`);
      continue;
    }
    // Textures inside the file, one file per scene
    const target = path.join(temp, "dist", `${scene.id}.glb`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await io.write(target, await io.read(glb));
    const size = fs.statSync(target).size;

    batch.push({ id: scene.id, file: target, record: { sha: scene.sha, size, info: sceneInfo(file, looks[scene.id]) } });
    batchBytes += size;
    if (batchBytes >= BATCH_BYTES || Date.now() - batchStarted >= BATCH_MS) {
      await flush();
    }
    if (packed) {
      fs.rmSync(path.join(temp, "package"), { recursive: true, force: true });
    }

    const minutes = (Date.now() - started) / 60000;
    console.log(
      `[${index + 1}/${todo.length}] ${scene.id} ${(size / 1e6).toFixed(1)} MB, ` +
        `about ${Math.round((minutes / (index + 1)) * (todo.length - index - 1))} min left`
    );
  }

  await flush();

  // The list the viewer reads
  const list = Object.entries(state.scenes)
    // Scenes of only particles and lights come out empty
    .filter(([, scene]) => !scene.empty && scene.size > 50000)
    .map(([id, scene]) => ({ id, name: sceneName(id), size: scene.size, file: `scenes/${id}.glb`, ...scene.info }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const listFile = path.join(temp, "scenes.json");
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(listFile, JSON.stringify(list));
  if (upload) {
    await hf.upload(repo, process.env.HF_TOKEN, [{ path: "scenes.json", file: listFile }], "Update the list of scenes");
  }
  console.log(`${list.length} scenes in the list`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
