// Paths of the files a compiled Source 2 resource depends on (its RERL block),
// e.g. a model lists its meshes, a mesh its materials, a material its textures.
// The paths come without the "_c" suffix of compiled files.
function externalRefs(buffer) {
  const blocksStart = 8 + buffer.readUInt32LE(8);
  const blockCount = buffer.readUInt32LE(12);

  for (let i = 0; i < blockCount; i++) {
    const block = blocksStart + i * 12;
    if (buffer.toString("ascii", block, block + 4) !== "RERL") {
      continue;
    }

    // Offsets are relative to the field they are read from
    const data = block + 4 + buffer.readUInt32LE(block + 4);
    const entries = data + buffer.readUInt32LE(data);
    const count = buffer.readUInt32LE(data + 4);
    const refs = [];

    for (let j = 0; j < count; j++) {
      const entry = entries + j * 16;
      const name = entry + 8 + buffer.readUInt32LE(entry + 8);
      refs.push(buffer.toString("utf8", name, buffer.indexOf(0, name)));
    }
    return refs;
  }

  return [];
}

module.exports = { externalRefs };
