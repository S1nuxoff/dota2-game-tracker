const fs = require("fs");
const { whoAmI, repoExists, createRepo, uploadFiles } = require("@huggingface/hub");

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

// files: [{ path: path in the dataset, file: local file }]
async function upload(repo, accessToken, files, title) {
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
        // The Hub is sometimes out of reach for minutes; wait it out rather than stop
        if (attempt >= 10) {
          throw error;
        }
        const wait = Math.min(attempt * 15, 120);
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

module.exports = { prepareRepo, upload };
