// Every picture of the game's interface, as the game keeps it, for anyone to use: the
// <user>/dota2-images dataset, at the game's paths (the videos are in dota2-videos, videos.js):
//   panorama/images/<path>.png or .jpg   a texture (<path>.vtex_c). Most hold a PNG or JPEG file
//                                        (formats PNG_RGBA8888, PNG_DXT5, JPEG_*): that file is
//                                        taken out byte for byte. The others (DXT5, BGRA8888, ...)
//                                        are decoded by Source2Viewer and written as PNG.
//   panorama/images/<path>.svg           a vector picture (<path>.vsvg_c), from Source2Viewer
//   panorama/images/<path>.png           a PNG the game keeps as it is
// Only files whose CRC changed since the last run are exported again (images-state.json); files
// the game removed are removed. Batches are uploaded as they are made and the state saved after
// each, so a stopped run goes on where it was.
//
//   HF_TOKEN=... node images.js --game "<...>/dota 2 beta/game/dota" [--no-upload] [--force] [--limit N]
//   HF_TOKEN=... node images.js <STEAM USERNAME> <STEAM PASSWORD>   (GitHub Actions)
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const hf = require("./hf");
const { localSource, steamSource } = require("./source");

const temp = "./temp/images";
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
const DATASET = process.env.HF_IMAGES_REPO || "dota2-images";
// Raised when the files written change, so a game version already exported is exported again
const VERSION = 1;
const STATE_FILE = "images-state.json";
const BATCH = 2000;

const IMAGES = /^panorama\/images\/.+\.(vtex_c|vsvg_c|png)$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// VTEX_FORMAT_* that hold a JPEG or PNG file
const JPEG_FORMATS = new Set([15, 17]);
const PNG_FORMATS = new Set([16, 18]);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// The PNG or JPEG file a compiled texture holds: { extension, data }, or null when its pixels
// are in another format. The resource's blocks are listed after its header; the texture's data
// (its pixels, here the file) follows its DATA block, whose header gives the format.
function embeddedImage(buffer) {
  const blocksAt = 8 + buffer.readUInt32LE(8);
  const blockCount = buffer.readUInt32LE(12);
  for (let index = 0; index < blockCount; index++) {
    const entry = blocksAt + index * 12;
    if (buffer.toString("latin1", entry, entry + 4) !== "DATA") continue;
    const dataAt = entry + 4 + buffer.readUInt32LE(entry + 4);
    const pixelsAt = dataAt + buffer.readUInt32LE(entry + 8);
    const format = buffer[dataAt + 26];
    if (PNG_FORMATS.has(format) && buffer.subarray(pixelsAt, pixelsAt + 8).equals(PNG_SIGNATURE)) {
      // Up to the end of its IEND chunk
      let at = pixelsAt + 8;
      while (at + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(at);
        const type = buffer.toString("latin1", at + 4, at + 8);
        at += 12 + length;
        if (type === "IEND") return { extension: ".png", data: buffer.subarray(pixelsAt, at) };
      }
      return null;
    }
    if (JPEG_FORMATS.has(format) && buffer[pixelsAt] === 0xff && buffer[pixelsAt + 1] === 0xd8) {
      const end = buffer.lastIndexOf(Buffer.from([0xff, 0xd9]));
      return end > pixelsAt ? { extension: ".jpg", data: buffer.subarray(pixelsAt, end + 2) } : null;
    }
    return null;
  }
  return null;
}

// One batch of VPK files to local files: [{ game file, path in the dataset, local file }]
async function convertBatch(source, files, out) {
  const buffers = new Map();
  await source.readFiles(files, buffers);
  const written = [];
  const write = (file, target, data) => {
    const local = path.join(out, target);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, data);
    written.push({ game: file, path: target, file: local });
  };
  // The ones Source2Viewer decodes
  const input = path.join(temp, "decode-in");
  const decoded = path.join(temp, "decode-out");
  fs.rmSync(input, { recursive: true, force: true });
  fs.rmSync(decoded, { recursive: true, force: true });
  const toDecode = [];
  for (const [file, buffer] of buffers) {
    const base = file.replace(/\.(vtex|vsvg)_c$/, "");
    if (!file.endsWith("_c")) {
      write(file, file, buffer);
      continue;
    }
    const image = file.endsWith(".vtex_c") ? embeddedImage(buffer) : null;
    if (image) {
      write(file, base + image.extension, image.data);
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
    fs.writeFileSync(path.join(input, file), buffer);
    toDecode.push(file);
  }
  const failed = [];
  if (toDecode.length) {
    const result = spawnSync(DECOMPILER, ["-i", input, "--recursive", "-o", decoded, "-d", "--threads", "8"], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }
    for (const file of toDecode) {
      const base = file.replace(/\.(vtex|vsvg)_c$/, "");
      // Source2Viewer writes a vector picture as .svg, a texture as .png (.jpeg for one from a JPEG)
      const found = [".svg", ".png", ".jpeg"].map((extension) => path.join(decoded, base + extension)).find((candidate) => fs.existsSync(candidate));
      if (found) {
        write(file, base + (found.endsWith(".jpeg") ? ".jpg" : path.extname(found)), fs.readFileSync(found));
      } else {
        failed.push(file);
      }
    }
  }
  return { written, failed };
}

async function main() {
  const game = argValue("--game");
  const limit = Number(argValue("--limit")) || Infinity;
  const [username, password] = process.argv
    .slice(2)
    .filter((arg, index, args) => !arg.startsWith("--") && !["--game", "--limit"].includes(args[index - 1]));
  const upload = !process.argv.includes("--no-upload");
  const force = process.argv.includes("--force");
  if ((!game && !password) || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node images.js --game "<...>/dota 2 beta/game/dota" | <STEAM USERNAME> <STEAM PASSWORD>');
    process.exit(1);
  }

  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const source = game ? localSource(game) : await steamSource(username, password, temp);
  let state = fs.existsSync(STATE_FILE) && !force ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  if (state.version !== VERSION) {
    state = { files: {} };
  }
  if (!force && source.manifestId && state.manifest === source.manifestId) {
    console.log(`Images of manifest ${source.manifestId} are already exported.`);
    return;
  }

  // What the game has now, by CRC
  const now = {};
  for (const file of source.vpkDir.files) {
    if (IMAGES.test(file)) now[file] = String(source.vpkDir.tree[file].crc);
  }

  const changed = Object.keys(now).filter((file) => state.files[file]?.hash !== now[file]).slice(0, limit);
  const removed = Object.keys(state.files).filter((file) => !(file in now));
  console.log(`${Object.keys(now).length} pictures, ${changed.length} to export, ${removed.length} removed`);

  const repo = upload ? await hf.prepareRepo(process.env.HF_TOKEN, DATASET) : null;
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify({ version: VERSION, manifest: state.manifest, files: state.files }));
  const out = path.join(temp, "out");
  let done = 0;
  let bytes = 0;
  const allFailed = [];

  const finish = async (written) => {
    bytes += written.reduce((sum, entry) => sum + fs.statSync(entry.file).size, 0);
    if (upload) {
      await hf.upload(repo, process.env.HF_TOKEN, written, "Update the game's pictures", { gzip: false, maxBytes: 200 * 1e6 });
      for (const entry of written) {
        state.files[entry.game] = { hash: now[entry.game], path: entry.path };
      }
      save();
      fs.rmSync(out, { recursive: true, force: true });
    }
    done += written.length;
    console.log(`${done} of ${changed.length} done, ${(bytes / 1e9).toFixed(2)} GB`);
  };

  for (let start = 0; start < changed.length; start += BATCH) {
    const { written, failed } = await convertBatch(source, changed.slice(start, start + BATCH), out);
    allFailed.push(...failed);
    await finish(written);
  }
  source.release();
  if (allFailed.length) {
    console.log(`Source2Viewer did not convert ${allFailed.length}: ${allFailed.slice(0, 10).join(", ")}`);
  }

  if (upload) {
    if (removed.length) {
      await hf.remove(repo, process.env.HF_TOKEN, removed.map((file) => state.files[file].path), "Remove what the game removed");
      for (const file of removed) delete state.files[file];
    }
    // Only a run that got through everything marks the game version done (what Source2Viewer did
    // not convert is tried again at the next game update)
    if (limit === Infinity) {
      state.manifest = source.manifestId;
    }
    save();
  } else {
    console.log(`Written to ${out}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
