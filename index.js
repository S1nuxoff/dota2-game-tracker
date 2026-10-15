const SteamUser = require("steam-user");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const vpk = require("vpk");
const { externalRefs } = require("./resource");
const { writeVpk } = require("./vpk-writer");

const appId = 570;
const depotIds = [373301, 381451, 381452, 381453, 381454, 381455];
const temp = "./temp";
const out = "./out";
const packPath = `${temp}/models.vpk`;
const ITEMS_URL =
  "https://raw.githubusercontent.com/S1nuxoff/dota2-file-tracker/main/static/items_game.json";
const DECOMPILER = "./vrf/Source2Viewer-CLI";

const DOWNLOAD_WORKERS = 16;
const CHUNK_RETRIES = 5;
const DIR_ARCHIVE = 0x7fff;

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

const user = new SteamUser();
const chunkCache = new Map();

async function main() {
  const [username, password, itemsArg = ""] = process.argv.slice(2);
  if (!username || !password || !itemsArg) {
    console.error('Usage: node index.js <USERNAME> <PASSWORD> "<item id, name or .vmdl path>,..."');
    process.exit(1);
  }

  console.log("Logging into Steam...");
  user.logOn({ accountName: username, password, rememberPassword: true, logonID: 2121 });
  await new Promise((resolve) => user.once("loggedOn", resolve));

  const targets = await resolveTargets(itemsArg.split(",").map((s) => s.trim()).filter(Boolean));
  const manifests = await getManifests();

  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(out, { recursive: true });

  const dirPath = `${temp}/pak01_dir.vpk`;
  console.log("Downloading pak01_dir.vpk");
  await user.downloadFile(appId, 373301, findArchive(manifests, "dir").file, dirPath);
  const vpkDir = new vpk(dirPath);
  vpkDir.load();

  await exportTargets(targets, vpkDir, dirPath, manifests);
}

async function exportTargets(targets, vpkDir, dirPath, manifests) {
  const files = new Map();

  for (const target of targets) {
    console.log(`\n${target.label}: ${target.models.join(", ")}`);
    const { wanted, missing } = await collect(target.models, vpkDir, dirPath, manifests, files);
    target.files = [...wanted].filter((file) => files.has(file));
    target.missing = missing;
    target.bytes = target.files.reduce((sum, file) => sum + files.get(file).length, 0);
    console.log(`${target.files.length} files, ${mb(target.bytes)}, ${missing.length} missing`);
  }

  writeVpk(packPath, files);

  const summary = [];
  for (const target of targets) {
    const targetOut = path.join(out, target.label);
    for (const model of target.models) {
      exportModel(model, targetOut);
    }

    const glbs = fs.existsSync(targetOut) ? [...walk(targetOut)].filter((f) => f.endsWith(".glb")) : [];
    const glbBytes = glbs.reduce((sum, f) => sum + fs.statSync(f).size, 0);
    const byType = {};
    for (const file of target.files) {
      const ext = file.slice(file.lastIndexOf(".") + 1);
      byType[ext] = (byType[ext] || 0) + 1;
    }

    summary.push(
      [
        `${target.label}`,
        `  models: ${target.models.join(", ")}`,
        `  game files: ${target.files.length} (${mb(target.bytes)}) ${JSON.stringify(byType)}`,
        `  missing: ${target.missing.length ? target.missing.join(", ") : "none"}`,
        `  glb: ${glbs.length} files, ${mb(glbBytes)}`,
        ...glbs.map((f) => `    ${path.relative(out, f)} ${mb(fs.statSync(f).size)}`),
      ].join("\n")
    );
  }

  const text = summary.join("\n\n");
  fs.writeFileSync(path.join(out, "summary.txt"), text + "\n");
  console.log(`\n${text}`);
}

// Item ids, item names or model paths -> [{ label, models }]
async function resolveTargets(inputs) {
  let items = null;
  const targets = [];

  for (const input of inputs) {
    if (input.endsWith(".vmdl")) {
      targets.push({ label: path.basename(input, ".vmdl"), models: [input] });
      continue;
    }

    if (!items) {
      console.log("Loading items_game.json");
      const res = await fetch(ITEMS_URL);
      if (!res.ok) {
        throw new Error(`Could not load items: HTTP ${res.status}`);
      }
      items = (await res.json()).items_game.items;
    }

    const id = items[input]
      ? input
      : Object.keys(items).find((key) => items[key].name?.toLowerCase() === input.toLowerCase());
    if (!id) {
      console.error(`Item not found: ${input}`);
      continue;
    }

    const models = modelsOf(items[id]);
    if (models.length === 0) {
      console.error(`Item ${id} "${items[id].name}" has no model`);
      continue;
    }
    targets.push({ label: `${id}_${slug(items[id].name)}`, models });
  }

  if (targets.length === 0) {
    throw new Error("Nothing to export");
  }
  return targets;
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

// Follows the dependencies of the models until nothing new comes up
async function collect(models, vpkDir, dirPath, manifests, files) {
  const wanted = new Set();
  const missing = [];
  let pending = models.map((model) => `${model}_c`);

  while (pending.length > 0) {
    const fresh = [...new Set(pending)].filter((file) => !wanted.has(file));
    pending = [];

    const found = [];
    for (const file of fresh) {
      wanted.add(file);
      if (files.has(file)) {
        continue;
      }
      if (vpkDir.tree[file]) {
        found.push(file);
      } else {
        missing.push(file);
      }
    }

    await readFiles(vpkDir, dirPath, found, manifests, files);

    for (const file of fresh) {
      if (!files.has(file)) {
        continue;
      }
      for (const ref of externalRefs(files.get(file))) {
        const ext = ref.slice(ref.lastIndexOf(".") + 1).toLowerCase();
        if (FOLLOW.has(ext)) {
          pending.push(`${ref.toLowerCase()}_c`);
        }
      }
    }
  }

  return { wanted, missing };
}

// With a filter matching exactly one file, -o is the output file, not a folder
function exportModel(model, targetOut) {
  const args = [
    "-i", packPath,
    "-f", `${model}_c`,
    "-o", path.join(targetOut, `${path.basename(model, ".vmdl")}.glb`),
    "-d",
    "--gltf_export_format", "glb",
    "--gltf_export_materials",
    "--gltf_export_animations",
  ];
  const result = spawnSync(DECOMPILER, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const log = `${result.stdout || ""}${result.stderr || ""}`;
  const problems = log.split("\n").filter((line) => /fail|error|exception/i.test(line));

  console.log(`Exported ${model}${problems.length ? `, ${problems.length} problems:` : ""}`);
  for (const line of problems.slice(0, 20)) {
    console.log(`  ${line.trim()}`);
  }
  if (result.error) {
    throw result.error;
  }
}

async function getManifests() {
  console.log(`Fetching product info for appId ${appId}`);
  const productInfo = await user.getProductInfo([appId], [], true);
  const depots = productInfo.apps[appId].appinfo.depots;
  const manifests = {};

  for (const depotId of depotIds) {
    const gid = depots[depotId]?.manifests?.public?.gid;
    if (!gid) {
      continue;
    }
    console.log(`Fetching manifest for depot ${depotId}`);
    const { manifest } = await user.getManifest(appId, depotId, gid, "public");
    manifests[depotId] = { manifestId: gid, files: manifest.files };
  }

  if (!manifests[373301]) {
    throw new Error("Manifest for depot 373301 could not be retrieved.");
  }
  return manifests;
}

// "dir" or an archive index
function findArchive(manifests, index) {
  const name = index === "dir" ? "pak01_dir.vpk" : `pak01_${String(index).padStart(3, "0")}.vpk`;
  const matches = (filename) => {
    const normalized = filename.replace(/\\/g, "/").toLowerCase();
    return normalized === `dota/${name}` || normalized.endsWith(`/dota/${name}`);
  };

  for (const depotId of depotIds) {
    const file = manifests[depotId]?.files.find((f) => matches(f.filename));
    if (file) {
      return { depotId, file };
    }
  }
  throw new Error(`${name} not found in any depot.`);
}

// Only the chunks that hold the files are downloaded, not whole archives
async function readFiles(vpkDir, dirPath, paths, manifests, files) {
  const dirFd = fs.openSync(dirPath, "r");
  const byArchive = new Map();

  for (const file of paths) {
    const { archiveIndex } = vpkDir.tree[file];
    if (!byArchive.has(archiveIndex)) {
      byArchive.set(archiveIndex, []);
    }
    byArchive.get(archiveIndex).push(file);
  }

  for (const [archiveIndex, archiveFiles] of byArchive) {
    if (archiveIndex === DIR_ARCHIVE) {
      for (const file of archiveFiles) {
        files.set(file, vpkDir.getFile(file));
      }
      continue;
    }

    const { depotId, file: archive } = findArchive(manifests, archiveIndex);
    const chunks = archive.chunks
      .map((chunk) => ({ sha: chunk.sha, offset: Number(chunk.offset), size: chunk.cb_original }))
      .sort((a, b) => a.offset - b.offset);

    const needed = new Map();
    for (const file of archiveFiles) {
      for (const chunk of chunksFor(vpkDir.tree[file], chunks)) {
        needed.set(chunk.sha, chunk);
      }
    }
    await downloadChunks(depotId, [...needed.values()]);

    for (const file of archiveFiles) {
      const entry = vpkDir.tree[file];
      const buffer = Buffer.alloc(entry.preloadBytes + entry.entryLength);
      if (entry.preloadBytes > 0) {
        fs.readSync(dirFd, buffer, 0, entry.preloadBytes, entry.preloadOffset);
      }

      const start = entry.entryOffset;
      const end = start + entry.entryLength;
      for (const chunk of chunksFor(entry, chunks)) {
        const from = Math.max(start, chunk.offset);
        const to = Math.min(end, chunk.offset + chunk.size);
        chunkCache.get(chunk.sha).copy(buffer, entry.preloadBytes + from - start, from - chunk.offset, to - chunk.offset);
      }

      if (zlib.crc32(buffer) !== entry.crc) {
        throw new Error(`CRC does not match for ${file}`);
      }
      files.set(file, buffer);
    }
  }

  fs.closeSync(dirFd);
}

function chunksFor(entry, chunks) {
  const start = entry.entryOffset;
  const end = start + entry.entryLength;
  return chunks.filter((chunk) => chunk.offset < end && chunk.offset + chunk.size > start);
}

async function downloadChunks(depotId, chunks) {
  const queue = chunks.filter((chunk) => !chunkCache.has(chunk.sha));

  const worker = async () => {
    while (queue.length > 0) {
      const chunk = queue.shift();
      for (let attempt = 1; ; attempt++) {
        try {
          chunkCache.set(chunk.sha, (await user.downloadChunk(appId, depotId, chunk.sha)).chunk);
          break;
        } catch (error) {
          if (attempt >= CHUNK_RETRIES) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
  };

  await Promise.all(Array.from({ length: DOWNLOAD_WORKERS }, worker));
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function mb(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
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

module.exports = { exportTargets, resolveTargets, modelsOf, collect };
