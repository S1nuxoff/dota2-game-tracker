const fs = require("fs");
const { whoAmI, repoExists, createRepo, uploadFiles } = require("@huggingface/hub");

// Keeps each commit to a reasonable size
const MAX_COMMIT_BYTES = 500 * 1e6;

// "<user>/dota2-models" by default
async function prepareRepo(accessToken, name) {
  if (!name) {
    const me = await whoAmI({ accessToken });
    name = `${me.name}/dota2-models`;
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
    await uploadFiles({
      repo,
      accessToken,
      commitTitle: title,
      files: part.map(({ path, file }) => ({ path, content: new Blob([fs.readFileSync(file)]) })),
    });
    console.log(`Uploaded ${part.length} files (${(partBytes / 1e6).toFixed(1)} MB)`);
    part = [];
    partBytes = 0;
  };

  for (const file of files) {
    const size = fs.statSync(file.file).size;
    if (partBytes + size > MAX_COMMIT_BYTES) {
      await commit();
    }
    part.push(file);
    partBytes += size;
  }
  await commit();
}

module.exports = { prepareRepo, upload };
