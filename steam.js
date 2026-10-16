const SteamUser = require("steam-user");
const fs = require("fs");
const zlib = require("zlib");

const appId = 570;
const depotIds = [373301, 381451, 381452, 381453, 381454, 381455];
const DOWNLOAD_WORKERS = 16;
const CHUNK_RETRIES = 5;
const DIR_ARCHIVE = 0x7fff;

const user = new SteamUser();
const chunkCache = new Map();

async function logOn(accountName, password) {
  console.log("Logging into Steam...");
  user.logOn({ accountName, password, rememberPassword: true, logonID: 2121 });
  await new Promise((resolve) => user.once("loggedOn", resolve));
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

function downloadVpkDir(manifests, outPath) {
  console.log("Downloading pak01_dir.vpk");
  return user.downloadFile(appId, 373301, findArchive(manifests, "dir").file, outPath);
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

// Reads files of the VPK into `files`, downloading only the chunks that hold them
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

// Files outside the VPKs under a folder of the game, e.g. "panorama/videos/heroes/", as the
// depots list them: [{ path, sha, depotId, file }], sha being the SHA-1 of the content
function looseFiles(manifests, folder) {
  const found = [];
  for (const depotId of depotIds) {
    for (const file of manifests[depotId]?.files ?? []) {
      const normalized = file.filename.replace(/\\/g, "/");
      const at = normalized.toLowerCase().indexOf(`dota/${folder}`);
      if (at >= 0 && file.size > 0) {
        const sha = Buffer.isBuffer(file.sha_content) ? file.sha_content.toString("hex") : String(file.sha_content).toLowerCase();
        found.push({ path: normalized.slice(at + "dota/".length), sha, depotId, file });
      }
    }
  }
  return found;
}

async function downloadLoose(entry) {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await user.downloadFile(appId, entry.depotId, entry.file)).file;
    } catch (error) {
      if (attempt >= CHUNK_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

function clearChunkCache() {
  chunkCache.clear();
}

module.exports = { user, logOn, getManifests, downloadVpkDir, readFiles, looseFiles, downloadLoose, clearChunkCache };
