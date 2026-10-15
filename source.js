const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const vpk = require("vpk");
const steam = require("./steam");

const DIR_ARCHIVE = 0x7fff;

// Where the game files come from: Steam (downloading only the chunks needed) or a
// local Dota 2 install. Both give { vpkDir, manifestId, readFiles(paths, files), release() }.

async function steamSource(username, password, temp) {
  await steam.logOn(username, password);
  const manifests = await steam.getManifests();
  const dirPath = path.join(temp, "pak01_dir.vpk");
  await steam.downloadVpkDir(manifests, dirPath);
  const vpkDir = new vpk(dirPath);
  vpkDir.load();

  return {
    vpkDir,
    manifestId: manifests[373301].manifestId,
    readFiles: (paths, files) => steam.readFiles(vpkDir, dirPath, paths, manifests, files),
    release: () => steam.clearChunkCache(),
  };
}

// gameDir: ".../steamapps/common/dota 2 beta/game/dota"
function localSource(gameDir) {
  const dirPath = path.join(gameDir, "pak01_dir.vpk");
  if (!fs.existsSync(dirPath)) {
    throw new Error(`${dirPath} not found, --game should point to the game/dota folder of the install`);
  }
  const vpkDir = new vpk(dirPath);
  vpkDir.load();

  // The vpk package opens a file for every read and never closes it, which runs out
  // of file handles over a whole export, so archives are read here with kept handles
  const handles = new Map();
  const handle = (file) => {
    if (!handles.has(file)) {
      handles.set(file, fs.openSync(file, "r"));
    }
    return handles.get(file);
  };
  const dataStart = vpkDir.header.treeLength + (vpkDir.header.version === 2 ? 28 : 12);

  const readFiles = async (paths, files) => {
    for (const file of paths) {
      const entry = vpkDir.tree[file];
      const buffer = Buffer.alloc(entry.preloadBytes + entry.entryLength);
      if (entry.preloadBytes > 0) {
        fs.readSync(handle(dirPath), buffer, 0, entry.preloadBytes, entry.preloadOffset);
      }
      if (entry.entryLength > 0) {
        const archive =
          entry.archiveIndex === DIR_ARCHIVE
            ? dirPath
            : path.join(gameDir, `pak01_${String(entry.archiveIndex).padStart(3, "0")}.vpk`);
        const offset = entry.archiveIndex === DIR_ARCHIVE ? dataStart + entry.entryOffset : entry.entryOffset;
        fs.readSync(handle(archive), buffer, entry.preloadBytes, entry.entryLength, offset);
      }
      if (zlib.crc32(buffer) !== entry.crc) {
        throw new Error(`CRC does not match for ${file}, the install may be updating`);
      }
      files.set(file, buffer);
    }
  };

  return { vpkDir, manifestId: installedManifest(gameDir), readFiles, release: () => {} };
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
