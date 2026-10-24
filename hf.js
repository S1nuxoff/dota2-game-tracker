const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { whoAmI, repoExists, createRepo, uploadFilesWithProgress, deleteFiles, listFiles } = require("@huggingface/hub");

const MB = (bytes) => (bytes / 1e6).toFixed(1);
// How often a commit's progress is printed
const PROGRESS_EVERY_MS = 3000;

// Sends one commit, printing each file as it is sent and, every few seconds, how far the commit is
// with the speed: [#####-----]  48%  95.2 / 199.7 MB  11.3 MB/s
async function sendCommit(params, part, label = "") {
  const sizes = new Map(part.map(({ path, file }) => [path, fs.statSync(file).size]));
  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  const progress = new Map();
  const reported = new Set();
  const started = Date.now();
  let printed = started;
  const sent = () => [...progress].reduce((sum, [path, value]) => sum + value * sizes.get(path), 0);
  const line = () => {
    const bytes = sent();
    const share = total ? bytes / total : 1;
    const bar = "#".repeat(Math.round(share * 20)).padEnd(20, "-");
    const speed = bytes / Math.max((Date.now() - started) / 1000, 0.001);
    return `  ${label}[${bar}] ${String(Math.round(share * 100)).padStart(3)}%  ${MB(bytes)} / ${MB(total)} MB  ${MB(speed)} MB/s`;
  };
  for await (const event of uploadFilesWithProgress(params)) {
    if (event.event !== "fileProgress") continue;
    // Hashing comes first; only the upload counts as sent
    if (event.state === "hashing") continue;
    progress.set(event.path, event.progress);
    if (event.progress >= 1 && !reported.has(event.path)) {
      reported.add(event.path);
      console.log(`  sent ${MB(sizes.get(event.path)).padStart(7)} MB  ${event.path}`);
    }
    if (Date.now() - printed >= PROGRESS_EVERY_MS) {
      printed = Date.now();
      console.log(line());
    }
  }
  // Small text files go inside the commit itself, without progress of their own
  for (const [path, size] of sizes) {
    progress.set(path, 1);
    if (!reported.has(path)) console.log(`  sent ${MB(size).padStart(7)} MB  ${path}`);
  }
  console.log(line());
}

// Keeps each commit to a reasonable size
const MAX_COMMIT_BYTES = 500 * 1e6;
const MAX_COMMIT_FILES = 1000;

// "<user>/dota2-models" by default; a name without "<user>/" goes under the token's user
async function prepareRepo(accessToken, name = "dota2-models") {
  if (!name.includes("/")) {
    const me = await whoAmI({ accessToken });
    name = `${me.name}/${name}`;
  }

  const repo = { type: "dataset", name };
  if (!(await repoExists({ repo, accessToken }))) {
    await createRepo({ repo, accessToken });
    console.log(`Created dataset ${name}`);
  }
  return repo;
}

// The dataset's index and data files: a JSON at most one folder deep, or a translation. Each has a
// gzipped copy next to it (<file>.json.gz), uploaded with it: Hugging Face serves files
// uncompressed, and these are what a page loads first (about 7 MB, a tenth of that gzipped).
// The sounds' phonemes too (phonemes.js), a few hundred KB a hero.
const gzippedJson = (datasetPath) => /^(dotadex\/)?([^/]+\/)?[^/]+\.json$|^(dotadex\/)?data\/i18n\/[^/]+\.json$|\/phonemes\.json$/.test(datasetPath);

// The files made for Dotadex (index.json, exported.json, data/...) live in the dota2-data dataset
// under dotadex/, next to the game's own files they are made from
const SITE_DATA_REPO = process.env.HF_DATA_REPO || "dota2-data";
const isSiteData = (datasetPath) => /^(data\/|index\.json$|exported\.json$)/.test(datasetPath);

// Uploads files given by their path under dotadex/ (data/heroes.json, index.json)
async function uploadSiteData(accessToken, files, title) {
  const repo = await prepareRepo(accessToken, SITE_DATA_REPO);
  await upload(repo, accessToken, files.map((entry) => ({ ...entry, path: `dotadex/${entry.path}` })), title);
}

// files: [{ path: path in the dataset, file: local file }]; gzip: false leaves out the gzipped
// copies (the game's own files in dota2-data, which pages do not load). maxBytes: a smaller commit
// for text files: the Hub keeps those (JSON among them) in the commit itself, which the library
// builds as one string, and past a few hundred MB that is longer than a string can be.
// parallel: how many commits are sent at once (each its own files)
async function upload(repo, accessToken, files, title, { gzip = true, maxBytes = MAX_COMMIT_BYTES, parallel = 1 } = {}) {
  files = files.flatMap((entry) => {
    if (!gzip || !gzippedJson(entry.path)) return [entry];
    const gz = `${entry.file}.gz`;
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(entry.file), { level: 9 }));
    return [entry, { path: `${entry.path}.gz`, file: gz }];
  });
  if (process.env.HF_STAGE_DIR) {
    stage(repo, files);
    return;
  }

  // The commits, each within the size and file limits
  const parts = [];
  let part = [];
  let partBytes = 0;
  for (const file of files) {
    const size = fs.statSync(file.file).size;
    if (part.length && (partBytes + size > maxBytes || part.length >= MAX_COMMIT_FILES)) {
      parts.push({ files: part, bytes: partBytes });
      part = [];
      partBytes = 0;
    }
    part.push(file);
    partBytes += size;
  }
  if (part.length) parts.push({ files: part, bytes: partBytes });

  const commit = async ({ files: part, bytes }, index) => {
    const label = parts.length > 1 && parallel > 1 ? `#${index + 1} ` : "";
    // Connections to the Hub drop now and then on long uploads, so retry a few times
    for (let attempt = 1; ; attempt++) {
      try {
        await sendCommit(
          {
            repo,
            accessToken,
            commitTitle: title,
            files: part.map(({ path, file }) => ({ path, content: new Blob([fs.readFileSync(file)]) })),
          },
          part,
          label
        );
        break;
      } catch (error) {
        // The Hub (or the way to it) is sometimes out of reach for minutes, up to an hour; wait it out
        // rather than stop. Past its limit of 128 commits an hour to a repository it says so; that
        // waits for the hour to pass.
        const limited = /rate limit/i.test(error.message ?? "");
        if (attempt >= (limited ? 20 : 30)) {
          throw error;
        }
        const wait = limited ? 5 * 60 : Math.min(attempt * 15, 120);
        console.log(`${label}Upload failed (${(error.cause?.code ?? error.message).slice(0, 80)}), retrying in ${wait} s`);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      }
    }
    console.log(`${label}Uploaded ${part.length} files (${MB(bytes)} MB)`);
  };

  // Up to `parallel` commits at a time
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const index = next++;
      await commit(parts[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, parts.length) }, worker));
}

// HF_STAGE_DIR: for a big upload, files are not sent but put in <HF_STAGE_DIR>/<dataset>/<path>
// (hard links, so at once and without taking space), and stage-upload.js sends each folder with
// `hf upload-large-folder`: many connections and large commits, many times faster. The exporters'
// state files then say "uploaded" before the files are: run stage-upload.js until it finishes.
function stage(repo, files) {
  const root = path.join(process.env.HF_STAGE_DIR, repo.name.split("/").pop());
  for (const { path: datasetPath, file } of files) {
    const target = path.join(root, datasetPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true });
    try {
      fs.linkSync(file, target);
    } catch {
      fs.copyFileSync(file, target);
    }
  }
  console.log(`Staged ${files.length} files for ${repo.name} in ${root}`);
}

// Removes files from the dataset, in commits of a reasonable size
async function remove(repo, accessToken, paths, title) {
  for (let start = 0; start < paths.length; start += MAX_COMMIT_FILES) {
    await deleteFiles({ repo, accessToken, paths: paths.slice(start, start + MAX_COMMIT_FILES), commitTitle: title });
    console.log(`Removed ${Math.min(paths.length - start, MAX_COMMIT_FILES)} files`);
  }
}

// The game's sounds come out as MP3 or WAV: the path each one has in the sounds dataset, by
// its path without the extension. Sound lists name these, so the site asks for what is there.
async function soundPaths(accessToken, name = "dota2-sounds") {
  const repo = await prepareRepo(accessToken, name);
  const paths = new Map();
  for (const file of await filesIn(repo, accessToken, "sounds", /\.(mp3|wav)$/)) {
    paths.set(file.replace(/\.(mp3|wav)$/, ""), file);
  }
  return paths;
}

// The paths of the files in a folder of the dataset that match the pattern
async function filesIn(repo, accessToken, folder, pattern) {
  const paths = [];
  for await (const file of listFiles({ repo, accessToken, path: folder, recursive: true })) {
    if (file.type === "file" && pattern.test(file.path)) {
      paths.push(file.path);
    }
  }
  return paths;
}

module.exports = { prepareRepo, upload, uploadSiteData, isSiteData, remove, soundPaths, filesIn, gzippedJson };
