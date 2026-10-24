// A list of every file of each dataset, at its root as files.json (and files.json.gz), so a page can
// show and search a whole dataset from one file instead of walking the Hub's API:
//   { dataset, commit, updated, files: [[path, size], ...] }   (sorted by path, without itself)
// commit is the dataset's revision the list was made from. A dataset is listed again only when its
// revision moved since the last run (files-state.json keeps the revision after the list's own commit).
//
//   HF_TOKEN=... node files-list.js [dataset ...] [--no-upload] [--force]
// Without names: every dataset the tracker writes.
const fs = require("fs");
const path = require("path");
const { listFiles, datasetInfo } = require("@huggingface/hub");
const hf = require("./hf");

const DATASETS = ["dota2-data", "dota2-images", "dota2-videos", "dota2-models", "dota2-particles", "dota2-sounds", "dota2-maps"];
const STATE_FILE = "files-state.json";
const LIST = "files.json";
const temp = "./temp/files-list";

async function main() {
  const accessToken = process.env.HF_TOKEN;
  const upload = !process.argv.includes("--no-upload");
  const force = process.argv.includes("--force");
  const names = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!accessToken) {
    console.error("Usage: HF_TOKEN=... node files-list.js [dataset ...] [--no-upload] [--force]");
    process.exit(1);
  }
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  fs.mkdirSync(temp, { recursive: true });

  for (const name of names.length ? names : DATASETS) {
    const repo = await hf.prepareRepo(accessToken, name);
    const revision = async () => (await datasetInfo({ name: repo.name, accessToken, additionalFields: ["sha"] })).sha;
    const commit = await revision();
    if (!force && state[name] === commit) {
      console.log(`${name}: unchanged since its list`);
      continue;
    }
    const files = [];
    for await (const file of listFiles({ repo, accessToken, recursive: true })) {
      if (file.type === "file" && file.path !== ".gitattributes" && !file.path.startsWith(`${LIST}`)) {
        files.push([file.path, file.size]);
      }
    }
    files.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const local = path.join(temp, `${name}.json`);
    fs.writeFileSync(local, JSON.stringify({ dataset: repo.name, commit, updated: new Date().toISOString(), files }));
    const bytes = files.reduce((sum, [, size]) => sum + size, 0);
    console.log(`${name}: ${files.length} files, ${(bytes / 1e9).toFixed(2)} GB, list ${(fs.statSync(local).size / 1e6).toFixed(1)} MB`);
    if (upload) {
      await hf.upload(repo, accessToken, [{ path: LIST, file: local }], "Update the list of files");
      // The revision after the list's own commit, so the next run sees no change
      state[name] = await revision();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
