// Sends what the exporters staged (HF_STAGE_DIR, see hf.js) with Hugging Face's own tool for big
// uploads: one `hf upload-large-folder` per dataset folder, many connections at once, resumable
// (run it again after a stop; it skips what is uploaded). Needs the `hf` command (pip install
// "huggingface_hub[hf_xet]") and HF_TOKEN.
//   HF_TOKEN=... node stage-upload.js <stage folder> [--workers 16]
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { whoAmI } = require("@huggingface/hub");

async function main() {
  const root = process.argv[2];
  const workersAt = process.argv.indexOf("--workers");
  const workers = workersAt >= 0 ? process.argv[workersAt + 1] : "16";
  if (!root || !process.env.HF_TOKEN) {
    console.error("Usage: HF_TOKEN=... node stage-upload.js <stage folder> [--workers 16]");
    process.exit(1);
  }
  const { name: owner } = await whoAmI({ accessToken: process.env.HF_TOKEN });
  const datasets = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const dataset of datasets) {
    const folder = path.join(root, dataset.name);
    console.log(`=== ${owner}/${dataset.name} from ${folder}`);
    const result = spawnSync("hf", ["upload-large-folder", `${owner}/${dataset.name}`, folder, "--repo-type", "dataset", "--num-workers", workers], {
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) {
      console.error(`hf upload-large-folder stopped for ${dataset.name} (exit ${result.status}); run this again to go on`);
      process.exit(1);
    }
  }
  console.log("All staged folders are uploaded; the stage folder can be removed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
