const fs = require("fs");
const zlib = require("zlib");
const { whoAmI, repoExists, createRepo, uploadFiles, listFiles } = require("@huggingface/hub");

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
// uncompressed, and these are what a page loads first (about 7 MB, a tenth of that gzipped)
const gzippedJson = (datasetPath) => /^([^/]+\/)?[^/]+\.json$|^data\/i18n\/[^/]+\.json$/.test(datasetPath);

// files: [{ path: path in the dataset, file: local file }]
async function upload(repo, accessToken, files, title) {
  files = files.flatMap((entry) => {
    if (!gzippedJson(entry.path)) return [entry];
    const gz = `${entry.file}.gz`;
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(entry.file), { level: 9 }));
    return [entry, { path: `${entry.path}.gz`, file: gz }];
  });
  let part = [];
  let partBytes = 0;

  const commit = async () => {
    if (part.length === 0) {
      return;
    }
    // Connections to the Hub drop now and then on long uploads, so retry a few times
    for (let attempt = 1; ; attempt++) {
      try {
        await uploadFiles({
          repo,
          accessToken,
          commitTitle: title,
          files: part.map(({ path, file }) => ({ path, content: new Blob([fs.readFileSync(file)]) })),
        });
        break;
      } catch (error) {
        // The Hub is sometimes out of reach for minutes; wait it out rather than stop. Past its
        // limit of 128 commits an hour to a repository it says so; that waits for the hour to pass.
        const limited = /rate limit/i.test(error.message ?? "");
        if (attempt >= (limited ? 20 : 10)) {
          throw error;
        }
        const wait = limited ? 5 * 60 : Math.min(attempt * 15, 120);
        console.log(`Upload failed (${(error.cause?.code ?? error.message).slice(0, 80)}), retrying in ${wait} s`);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      }
    }
    console.log(`Uploaded ${part.length} files (${(partBytes / 1e6).toFixed(1)} MB)`);
    part = [];
    partBytes = 0;
  };

  for (const file of files) {
    const size = fs.statSync(file.file).size;
    if (partBytes + size > MAX_COMMIT_BYTES || part.length >= MAX_COMMIT_FILES) {
      await commit();
    }
    part.push(file);
    partBytes += size;
  }
  await commit();
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

module.exports = { prepareRepo, upload, soundPaths, filesIn, gzippedJson };
