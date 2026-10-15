const fs = require("fs");
const zlib = require("zlib");

// Writes a version 1 VPK with the file data stored right after the tree,
// so Source2Viewer can load a model together with its dependencies from it.
function writeVpk(outPath, files) {
  const tree = new Map();

  for (const [filePath, data] of files) {
    const slash = filePath.lastIndexOf("/");
    const dot = filePath.lastIndexOf(".");
    const dir = slash < 0 ? " " : filePath.slice(0, slash);
    const name = filePath.slice(slash + 1, dot);
    const ext = filePath.slice(dot + 1);

    if (!tree.has(ext)) {
      tree.set(ext, new Map());
    }
    const dirs = tree.get(ext);
    if (!dirs.has(dir)) {
      dirs.set(dir, []);
    }
    dirs.get(dir).push({ name, data });
  }

  const parts = [];
  const blobs = [];
  let offset = 0;
  const string = (value) => parts.push(Buffer.from(value + "\0", "utf8"));

  for (const [ext, dirs] of tree) {
    string(ext);
    for (const [dir, list] of dirs) {
      string(dir);
      for (const { name, data } of list) {
        string(name);
        const entry = Buffer.alloc(18);
        entry.writeUInt32LE(zlib.crc32(data), 0);
        entry.writeUInt16LE(0, 4); // preload bytes
        entry.writeUInt16LE(0x7fff, 6); // data is in this file
        entry.writeUInt32LE(offset, 8);
        entry.writeUInt32LE(data.length, 12);
        entry.writeUInt16LE(0xffff, 16);
        parts.push(entry);
        blobs.push(data);
        offset += data.length;
      }
      string("");
    }
    string("");
  }
  string("");

  const treeBuffer = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(treeBuffer.length, 8);

  fs.writeFileSync(outPath, Buffer.concat([header, treeBuffer, ...blobs]));
}

module.exports = { writeVpk };
