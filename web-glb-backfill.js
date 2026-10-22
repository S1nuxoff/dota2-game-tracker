// The site's copies (<model>.glb.gz, web-glb.js) for the models uploaded before index.js made them:
// every .glb in the dataset without a .glb.gz next to it is downloaded, made lighter and uploaded.
// Safe to stop and run again, it goes on from what the dataset has.
//   HF_TOKEN=... node web-glb-backfill.js [--limit N]
const fs = require("fs");
const path = require("path");
const { NodeIO } = require("@gltf-transform/core");
const { ALL_EXTENSIONS } = require("@gltf-transform/extensions");
const hf = require("./hf");
const { webGlb } = require("./web-glb");

const outDir = "./temp/web-glb";
const PARALLEL = 4;
// Uploaded in parts, so a stop loses little
const PART_BYTES = 400 * 1e6;

async function main() {
  const accessToken = process.env.HF_TOKEN;
  if (!accessToken) {
    console.error("Usage: HF_TOKEN=... node web-glb-backfill.js [--limit N]");
    process.exit(1);
  }
  const limitAt = process.argv.indexOf("--limit");
  const limit = limitAt > 0 ? Number(process.argv[limitAt + 1]) : Infinity;
  const repo = await hf.prepareRepo(accessToken, process.env.HF_REPO);
  const base = `https://huggingface.co/datasets/${repo.name}/resolve/main/`;

  const files = new Set(await hf.filesIn(repo, accessToken, "models", /\.glb(\.gz)?$/));
  const todo = [...files].filter((file) => file.endsWith(".glb") && !files.has(`${file}.gz`)).slice(0, limit);
  console.log(`${todo.length} models without the site's copy`);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  let ready = [];
  let readyBytes = 0;
  let done = 0;
  let inBytes = 0;
  let outBytes = 0;
  const start = Date.now();

  // Takes the files made so far and uploads them after the uploads before
  let uploading = Promise.resolve();
  const flush = () => {
    const part = ready;
    ready = [];
    readyBytes = 0;
    if (part.length === 0) return uploading;
    uploading = uploading.then(async () => {
      await hf.upload(repo, accessToken, part, `Site copies of ${part.length} models`);
      for (const { file } of part) fs.rmSync(file);
    });
    return uploading;
  };

  const work = async (model) => {
    const target = path.join(outDir, `${model}.gz`);
    // Made in a run that stopped before uploading it
    if (!fs.existsSync(target)) {
      let glb = null;
      for (let attempt = 1; !glb; attempt++) {
        try {
          const res = await fetch(base + model.split("/").map(encodeURIComponent).join("/"));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          glb = new Uint8Array(await res.arrayBuffer());
        } catch (error) {
          if (attempt >= 5) {
            console.log(`Skipped ${model}: ${error.message}`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, attempt * 10000));
        }
      }
      inBytes += glb.length;
      let gz;
      try {
        gz = await webGlb(io, await io.readBinary(glb));
      } catch (error) {
        console.log(`Skipped ${model}: ${error.message}`);
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, gz);
    }
    const size = fs.statSync(target).size;
    outBytes += size;
    ready.push({ path: `${model}.gz`, file: target });
    readyBytes += size;
    done++;
  };

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      await work(todo[next++]);
      if (readyBytes >= PART_BYTES) {
        // One upload at a time, the workers go on meanwhile
        flush();
      }
      if (done % 200 === 0 && done > 0) {
        const minutes = (Date.now() - start) / 60000;
        console.log(
          `${done}/${todo.length}, ${(inBytes / 1e9).toFixed(2)} GB in, ${(outBytes / 1e9).toFixed(2)} GB out, ` +
            `${Math.round(minutes)} min, about ${Math.round((minutes / done) * (todo.length - done))} min left`
        );
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  await flush();
  console.log(`Done: ${done} models, ${(inBytes / 1e9).toFixed(2)} GB became ${(outBytes / 1e9).toFixed(2)} GB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
