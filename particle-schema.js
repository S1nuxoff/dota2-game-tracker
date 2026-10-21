// The particle classes as the engine describes them (its SchemaSystem): each class's base, its
// fields and the defaults the engine gives the ones a .vpcf leaves out. A .vpcf writes only the
// fields that differ from the default, so the site needs these to read a system as the game does.
//
// For now the schema comes from DotaFlow's dump of the client (a bot commits it after every game
// update): github.com/DotaFlow/dota2_client_dump, sdk/include/source2sdk/schemas/<module>/<Class>.h,
// fetched with a sparse clone of only the particle modules (a few MB of the 1.5 GB repo). Later it
// is to be dumped from the game's own binaries.
//
//   node particle-schema.js [out.json]      writes it alone, to look at
//
// Output (particles/schema.json in the dataset):
//   { source: { repo, commit, build }, shared: [value], classes: { <Class>: { base?,
//     fields: { <field>: default | null }, refs?: { <field>: <index in shared> },
//     types?: { <field>: <Class> } } } }
// fields lists every field of the class itself (not its bases'); null where the dump gives no
// default (the engine's zero, or a base class the engine never builds alone) or where the default
// is an object, kept once in shared and named by refs. types names the schema class a field
// holds, or holds a list of, where the site fills defaults inside it too.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = "DotaFlow/dota2_client_dump";
const MODULES = ["particles", "particleslib"];
const ROOT = "sdk/include/source2sdk/schemas";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]}: ${(result.stderr || result.error?.message || "").trim()}`);
  }
  return result.stdout.trim();
}

// The dump's newest commit, only the particle modules checked out
function fetchDump(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  git(["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--sparse", `https://github.com/${REPO}.git`, dir]);
  git(["sparse-checkout", "set", "--no-cone", ...MODULES.map((module) => `${ROOT}/${module}/*`)], dir);
  const [commit, subject] = git(["log", "-1", "--format=%H%n%s"], dir).split("\n");
  // "[Auto] 6964 -> 6965: 26 files changed" or "Manual dump for 6965: 280 files changed"
  const build = Number(subject.match(/(\d+): \d+ files? changed/)?.[1]) || null;
  return { commit, build };
}

// One header: "class X : public Y { <type> <name>; // = <json default> ... };" (enums are skipped)
function parseHeader(text) {
  const head = text.match(/^class (\w+)(?: : public (\w+))?\s*$/m);
  if (!head) {
    return null;
  }
  const fields = {};
  const types = {};
  for (const line of text.split(/\r?\n/)) {
    const field = line.match(/^\t(.+?) (\w+)(\[\d+\])?;(?: \/\/ = (.*))?$/);
    if (!field) {
      continue;
    }
    const [, type, name, , value] = field;
    fields[name] = value === undefined ? null : JSON.parse(value);
    // A struct held by value, or a list of them ("CUtlVector< TextureGroup_t >"); pointers are
    // polymorphic and carry their _class
    const held = type.match(/^(?:\w+<\s*)?(\w+)(?:\s*>)?$/)?.[1];
    if (held) {
      types[name] = held;
    }
  }
  return { name: head[1], base: head[2], fields, types };
}

function readSchema(dir) {
  const classes = {};
  for (const module of MODULES) {
    const folder = path.join(dir, ROOT, module);
    for (const file of fs.readdirSync(folder)) {
      const parsed = parseHeader(fs.readFileSync(path.join(folder, file), "utf8"));
      if (parsed) {
        classes[parsed.name] = parsed;
      }
    }
  }
  // Only the types with a default somewhere in them count (not a boxed number such as
  // ParticleAttributeIndex_t)
  const hasDefaults = (name) => {
    for (let c = classes[name]; c; c = classes[c.base]) {
      if (Object.values(c.fields).some((value) => value !== null)) return true;
    }
    return false;
  };
  // The inputs' defaults repeat hundreds of times; each object default is kept once in `shared`
  // and a field gives its index there instead (in `refs`)
  const shared = [];
  const index = new Map();
  const out = {};
  for (const [name, { base, fields, types }] of Object.entries(classes)) {
    const held = Object.fromEntries(Object.entries(types).filter(([, type]) => type !== name && hasDefaults(type)));
    const refs = {};
    for (const [field, value] of Object.entries(fields)) {
      if (value && typeof value === "object") {
        const key = JSON.stringify(value);
        if (!index.has(key)) index.set(key, shared.push(value) - 1);
        refs[field] = index.get(key);
        fields[field] = null;
      }
    }
    out[name] = { ...(base && { base }), fields, ...(Object.keys(refs).length && { refs }), ...(Object.keys(held).length && { types: held }) };
  }
  return { shared, classes: out };
}

// Fetches the dump and writes the schema to `out`; returns { source, classes } or null when the
// dump could not be fetched (the run goes on without it, the dataset keeps the last one)
function exportSchema(out, work) {
  try {
    const source = { repo: REPO, ...fetchDump(work) };
    const schema = { source, ...readSchema(work) };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(schema));
    return schema;
  } catch (error) {
    console.log(`Particle schema not fetched: ${error.message}`);
    return null;
  }
}

if (require.main === module) {
  const out = process.argv[2] ?? "temp/particle-schema.json";
  const schema = exportSchema(out, "temp/particle-schema-dump");
  if (!schema) process.exit(1);
  console.log(`${Object.keys(schema.classes).length} classes from ${schema.source.repo}@${schema.source.commit.slice(0, 7)} (build ${schema.source.build}) in ${out}, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
}

module.exports = { exportSchema };
