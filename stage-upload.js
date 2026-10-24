// Sends what the exporters staged (HF_STAGE_DIR, see hf.js) with Hugging Face's own command line:
// one `hf upload` per dataset folder (it splits a big folder into commits and goes on where it
// stopped when run again), with Xet's high performance mode (many connections at once). Needs the
// `hf` command (pip install "huggingface_hub[hf_xet]", 2.x) and HF_TOKEN.
//   HF_TOKEN=... node stage-upload.js <stage folder>
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { whoAmI } = require("@huggingface/hub");

async function main() {
  const root = process.argv[2];
  if (!root || !process.env.HF_TOKEN) {
    console.error("Usage: HF_TOKEN=... node stage-upload.js <stage folder>");
    process.exit(1);
  }
  const { name: owner } = await whoAmI({ accessToken: process.env.HF_TOKEN });
  const datasets = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const dataset of datasets) {
    const folder = path.join(root, dataset.name);
    console.log(`=== ${owner}/${dataset.name} from ${folder}`);
    const result = spawnSync("hf", ["upload", `${owner}/${dataset.name}`, folder, ".", "--repo-type", "dataset", "--commit-message", "Big upload from the tracker"], {
      stdio: "inherit",
      env: { ...process.env, HF_XET_HIGH_PERFORMANCE: "1" },
    });
    if (result.status !== 0) {
      console.error(`hf upload stopped for ${dataset.name} (exit ${result.status}); run this again to go on`);
      process.exit(1);
    }
  }
  console.log("All staged folders are uploaded; the stage folder can be removed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
