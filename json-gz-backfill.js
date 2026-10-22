// The gzipped copies of the dataset's index and data files (hf.js gzippedJson) for the files
// uploaded before hf.upload made them: each is downloaded, gzipped and its .gz uploaded.
//   HF_TOKEN=... node json-gz-backfill.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const hf = require("./hf");

const outDir = "./temp/json-gz";

async function main() {
  const accessToken = process.env.HF_TOKEN;
  if (!accessToken) {
    console.error("Usage: HF_TOKEN=... node json-gz-backfill.js");
    process.exit(1);
  }
  const repo = await hf.prepareRepo(accessToken, process.env.HF_REPO);
  const base = `https://huggingface.co/datasets/${repo.name}/resolve/main/`;
  // Only the top two levels and the translations can hold such files
  const files = [];
  for (const folder of ["", "data", "data/i18n", "particles", "materials", "models", "cubemaps"]) {
    const res = await fetch(`https://huggingface.co/api/datasets/${repo.name}/tree/main/${folder}`);
    for (const entry of await res.json()) {
      if (entry.type === "file" && hf.gzippedJson(entry.path)) files.push(entry.path);
    }
  }
  console.log(`${files.length} files`);
  const uploads = [];
  for (const file of files) {
    const res = await fetch(base + file);
    if (!res.ok) {
      console.log(`Skipped ${file}: HTTP ${res.status}`);
      continue;
    }
    const target = path.join(outDir, `${file}.gz`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, zlib.gzipSync(Buffer.from(await res.arrayBuffer()), { level: 9 }));
    uploads.push({ path: `${file}.gz`, file: target });
  }
  await hf.upload(repo, accessToken, uploads, `Gzipped copies of ${uploads.length} data files`);
  console.log(`Done: ${uploads.length} files`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
