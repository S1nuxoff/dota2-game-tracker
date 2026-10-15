// Scenes and maps of the game as glTF: MVP showcases, treasure openings, main menu
// backgrounds, event and battle pass scenes, and the game's maps, each a .glb with its
// textures inside. Only scenes whose files changed are exported again (scenes-state.json).
//
//   HF_TOKEN=... node scenes.js --game "<...>/dota 2 beta/game/dota" [--only mvp] [--limit N] [--no-upload]
//
// Uploads to the <user>/dota2-scenes dataset: scenes/<path>.glb and scenes.json
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const hf = require("./hf");

const temp = "./temp/scenes";
const STATE_FILE = "scenes-state.json";
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
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

async function main() {
  const game = argValue("--game");
  const only = argValue("--only");
  const limit = Number(argValue("--limit")) || Infinity;
  const upload = !process.argv.includes("--no-upload");
  if (!game || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node scenes.js --game "<...>/dota 2 beta/game/dota" [--only <folder>] [--limit N]');
    process.exit(1);
  }

  const mapsDir = path.join(game, "maps");
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { scenes: {} };
  const packages = [...walk(mapsDir)]
    .filter((file) => file.endsWith(".vpk") && !/_\d{3}\.vpk$/.test(file))
    .map((file) => ({ file, id: path.relative(mapsDir, file).split(path.sep).join("/").replace(/\.vpk$/, "") }))
    .filter((scene) => !only || scene.id.startsWith(only));
  const todo = packages.filter((scene) => state.scenes[scene.id]?.fingerprint !== fingerprint(scene.file)).slice(0, limit);
  console.log(`${packages.length} scenes and maps, ${todo.length} to export.`);

  const repo = upload ? await hf.prepareRepo(process.env.HF_TOKEN, process.env.HF_SCENES_REPO || "dota2-scenes") : null;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const started = Date.now();

  for (const [index, scene] of todo.entries()) {
    const out = path.join(temp, "export");
    fs.rmSync(out, { recursive: true, force: true });
    // The package's map, e.g. maps/scenes/mvp/mvp_default.vmap_c
    const listing = run(["-i", scene.file, "-l"]);
    const vmap = listing.match(/^(\S+\.vmap_c)/m)?.[1];
    if (!vmap) {
      console.log(`${scene.id}: no map inside`);
      state.scenes[scene.id] = { fingerprint: fingerprint(scene.file), empty: true };
      continue;
    }

    run(["-i", scene.file, "-f", vmap, "-o", path.join(out, "scene.glb"), "-d", "--gltf_export_format", "glb", "--gltf_export_materials"]);
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

    if (upload) {
      await hf.upload(repo, process.env.HF_TOKEN, [{ path: `scenes/${scene.id}.glb`, file: target }], `Scene ${scene.id}`);
    }
    state.scenes[scene.id] = { fingerprint: fingerprint(scene.file), size };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
    fs.rmSync(target, { force: true });

    const minutes = (Date.now() - started) / 60000;
    console.log(
      `[${index + 1}/${todo.length}] ${scene.id} ${(size / 1e6).toFixed(1)} MB, ` +
        `about ${Math.round((minutes / (index + 1)) * (todo.length - index - 1))} min left`
    );
  }

  // The list the viewer reads
  const list = Object.entries(state.scenes)
    // Scenes of only particles and lights come out empty
    .filter(([, scene]) => !scene.empty && scene.size > 50000)
    .map(([id, scene]) => ({ id, name: sceneName(id), size: scene.size, file: `scenes/${id}.glb` }))
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
