const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const vpk = require("vpk");
const steam = require("./steam");

const DIR_ARCHIVE = 0x7fff;

// Where the game files come from: Steam (downloading only the chunks needed) or a
// local Dota 2 install. Both give { vpkDir, manifestId, readFiles(paths, files), release() },
// and for files outside the VPKs looseFiles(folder) -> [{ path, sha }] and readLoose(entry) -> Buffer.
//
// The VPKs are read as the game reads them: its own (game/dota) first, then core (game/core, the
// files the engine shares, many particle textures among them). vpkDir.tree and vpkDir.files are
// over both, a file of the game's own VPK taking the place of core's.
const GAMES = ["dota", "core"];

// One tree over the packs, and which pack each file is read from
function mergePacks(packs) {
  const tree = {};
  const owner = new Map();
  for (const pack of [...packs].reverse()) {
    for (const [file, entry] of Object.entries(pack.vpkDir.tree)) {
      tree[file] = entry;
      owner.set(file, pack);
    }
  }
  return { vpkDir: { tree, files: Object.keys(tree) }, owner };
}

// Paths grouped by the pack they are read from
function byPack(owner, paths) {
  const groups = new Map();
  for (const file of paths) {
    const pack = owner.get(file);
    if (!groups.has(pack)) {
      groups.set(pack, []);
    }
    groups.get(pack).push(file);
  }
  return groups;
}

async function steamSource(username, password, temp) {
  await steam.logOn(username, password);
  const manifests = await steam.getManifests();
  const packs = [];
  for (const game of GAMES) {
    const dirPath = path.join(temp, game === "dota" ? "pak01_dir.vpk" : `${game}_pak01_dir.vpk`);
    // Only the game's own VPK has to be there
    if (game !== "dota" && !steam.hasVpkDir(manifests, game)) {
      console.log(`No ${game} VPK in the depots, reading game/dota only`);
      continue;
    }
    await steam.downloadVpkDir(manifests, dirPath, game);
    const vpkDir = new vpk(dirPath);
    vpkDir.load();
    packs.push({ game, dirPath, vpkDir });
  }
  const { vpkDir, owner } = mergePacks(packs);

  return {
    vpkDir,
    manifestId: manifests[373301].manifestId,
    readFiles: async (paths, files) => {
      for (const [pack, list] of byPack(owner, paths)) {
        await steam.readFiles(pack.vpkDir, pack.dirPath, list, manifests, files, pack.game);
      }
    },
    looseFiles: (folder) => steam.looseFiles(manifests, folder),
    readLoose: (entry) => steam.downloadLoose(entry),
    release: () => steam.clearChunkCache(),
  };
}

// gameDir: ".../steamapps/common/dota 2 beta/game/dota"
function localSource(gameDir) {
  const packs = [];
  for (const game of GAMES) {
    const folder = game === "dota" ? gameDir : path.resolve(gameDir, "..", game);
    const dirPath = path.join(folder, "pak01_dir.vpk");
    if (!fs.existsSync(dirPath)) {
      if (game === "dota") {
        throw new Error(`${dirPath} not found, --game should point to the game/dota folder of the install`);
      }
      console.log(`No ${dirPath}, reading game/dota only`);
      continue;
    }
    const vpkDir = new vpk(dirPath);
    vpkDir.load();
    packs.push({ game, folder, dirPath, vpkDir, dataStart: vpkDir.header.treeLength + (vpkDir.header.version === 2 ? 28 : 12) });
  }
  const { vpkDir, owner } = mergePacks(packs);

  // The vpk package opens a file for every read and never closes it, which runs out
  // of file handles over a whole export, so archives are read here with kept handles
  const handles = new Map();
  const handle = (file) => {
    if (!handles.has(file)) {
      handles.set(file, fs.openSync(file, "r"));
    }
    return handles.get(file);
  };

  const readFiles = async (paths, files) => {
    for (const file of paths) {
      const pack = owner.get(file);
      const entry = vpkDir.tree[file];
      const buffer = Buffer.alloc(entry.preloadBytes + entry.entryLength);
      if (entry.preloadBytes > 0) {
        fs.readSync(handle(pack.dirPath), buffer, 0, entry.preloadBytes, entry.preloadOffset);
      }
      if (entry.entryLength > 0) {
        const archive =
          entry.archiveIndex === DIR_ARCHIVE
            ? pack.dirPath
            : path.join(pack.folder, `pak01_${String(entry.archiveIndex).padStart(3, "0")}.vpk`);
        const offset = entry.archiveIndex === DIR_ARCHIVE ? pack.dataStart + entry.entryOffset : entry.entryOffset;
        fs.readSync(handle(archive), buffer, entry.preloadBytes, entry.entryLength, offset);
      }
      if (zlib.crc32(buffer) !== entry.crc) {
        throw new Error(`CRC does not match for ${file}, the install may be updating`);
      }
      files.set(file, buffer);
    }
  };

  // Hashed as Steam's manifests hash them, so a local export and one from Steam agree
  const looseFiles = (folder) => {
    const root = path.join(gameDir, folder);
    if (!fs.existsSync(root)) {
      return [];
    }
    return fs.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        const relative = path.relative(gameDir, file).replace(/\\/g, "/");
        return { path: relative, sha: crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex"), file };
      });
  };
  const readLoose = async (entry) => fs.readFileSync(entry.file);

  return { vpkDir, gameDir, manifestId: installedManifest(gameDir), readFiles, looseFiles, readLoose, release: () => {} };
}

// The manifest of the main depot from Steam's appmanifest_570.acf, next to steamapps/common
function installedManifest(gameDir) {
  const acf = path.resolve(gameDir, "../../../../appmanifest_570.acf");
  if (!fs.existsSync(acf)) {
    return null;
  }
  const text = fs.readFileSync(acf, "utf8");
  return text.match(/"373301"\s*\{\s*"manifest"\s*"(\d+)"/)?.[1] ?? null;
}

module.exports = { steamSource, localSource };
