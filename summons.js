// The units a hero's page puts on the pedestal beside the hero: the "summons" of the hero's entry in
// scripts/npc/portraits_full_body_loadout.txt (Warlock's Golem, Beastmaster's hawk and boar, ...),
// each at its place, turned and scaled, and drawn with its unit's model from scripts/npc/npc_units.txt.
// A summon's name is the unit's own (npc_dota_warlock_golem), or a name the units carry in theirs
// (npc_dota_shadow_shaman_ward for npc_dota_shadow_shaman_ward_1..3; client.dll matches units to
// these names by what their names contain): then the first such unit in the file.

const UNITS_FILE = "scripts/npc/npc_units.txt";
const LOADOUT_PORTRAITS = "scripts/npc/portraits_full_body_loadout.txt";

const vector = (value) => (value ?? "").trim().split(/\s+/).map(Number);
const glb = (model) => model.toLowerCase().replace(/\.vmdl$/, ".glb");

// The unit a summon's name stands for, or null
function unitOf(units, name) {
  if (units[name]?.Model) return units[name];
  const key = Object.keys(units).find((unit) => unit.includes(name) && units[unit]?.Model);
  return key ? units[key] : null;
}

// [{ unit, model, modelScale, position, angles, scale }] of one portrait entry: position in the game's
// units from the hero's origin, angles in degrees, scale the page's; modelScale the unit's own
function summonsOf(entry, units) {
  return Object.entries(entry?.summons ?? {})
    .map(([name, summon]) => {
      const unit = unitOf(units, name);
      if (!unit || typeof summon !== "object") return null;
      return {
        unit: name,
        model: glb(unit.Model),
        modelScale: Number(unit.ModelScale ?? 1),
        position: vector(summon.Position ?? "0 0 0"),
        angles: vector(summon.Angles ?? "0 0 0"),
        scale: Number(summon.Scale ?? 1),
      };
    })
    .filter(Boolean);
}

module.exports = { summonsOf, UNITS_FILE, LOADOUT_PORTRAITS };
