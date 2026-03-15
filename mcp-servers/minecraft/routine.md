# Minecraft Bot Mining Routine

## Quick Start Instructions
**When the user references this file, immediately:**
1. Connect the bot using the connection details below
2. Start the mining script as a background task
3. Begin OODA loop monitoring (check every 30-60 seconds)

Do NOT ask for confirmation - just connect and start mining.

---

## Self-Improvement Rule
**When you encounter bugs or errors during operation:**
1. Fix the issue immediately to keep the bot running
2. Update this routine.md file with the patched code
3. Document what went wrong in the Patch History section
4. This ensures future sessions benefit from lessons learned

---

## Consciousness Architecture

The bot operates on two levels:

### Subconscious (Background Control Loops)
Automatic reactive systems running as setInterval on the bot:
- **Defense Loop (300ms):** Auto-attack hostiles within 5 blocks
- **Food Loop (2s):** Auto-eat when food < 14
- **Follow Loop (1s):** Maintain follow goal on player

These handle immediate survival without conscious thought.

### Consciousness (Agent OODA Loop)
The Claude agent runs high-level monitoring every 30-60 seconds:
- Strategic decisions (where to mine, when to return)
- Resource management (pickaxe supply, inventory space)
- Threat assessment (should we flee this area?)
- Memory updates (record learnings to routine.md)

**Key principle:** Subconscious keeps bot alive, consciousness makes decisions.

### Activating Control Loops
```javascript
// Clear existing intervals
if (bot._defenseInterval) clearInterval(bot._defenseInterval);
if (bot._foodInterval) clearInterval(bot._foodInterval);
if (bot._followInterval) clearInterval(bot._followInterval);

const hostileTypes = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch',
  'phantom', 'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'ravager', 'warden',
  'zombie_villager', 'cave_spider', 'silverfish', 'slime', 'magma_cube', 'blaze', 'ghast'];

// Defense Loop (300ms)
let inCombat = false;
bot._defenseInterval = setInterval(async () => {
  if (inCombat) return;
  const nearbyHostiles = Object.values(bot.entities).filter(e => {
    if (!e.name || !e.position) return false;
    return hostileTypes.some(h => e.name.includes(h)) && e.position.distanceTo(bot.entity.position) < 5;
  });
  if (nearbyHostiles.length > 0) {
    inCombat = true;
    try {
      const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
      if (pick) await bot.equip(pick, 'hand');
      await bot.attack(nearbyHostiles[0]);
    } catch (e) {}
    inCombat = false;
  }
}, 300);

// Food Loop (2s)
let eating = false;
bot._foodInterval = setInterval(async () => {
  if (eating || bot.food >= 14) return;
  eating = true;
  try {
    const food = bot.inventory.items().find(i => i.name.includes('cod') || i.name.includes('cooked') || i.name === 'bread');
    if (food) {
      await bot.equip(food, 'hand');
      await bot.consume();
    }
  } catch (e) {}
  eating = false;
}, 2000);

// Follow Loop (1s)
bot._followInterval = setInterval(() => {
  const player = bot.players['lmoik'];
  if (player?.entity && !bot.pathfinder.goal) {
    bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
  }
}, 1000);

return 'Control loops active';
```

---

## OODA Loop Monitoring

Run this loop continuously while the bot is active:

### Observe
Check bot status every 30-60 seconds:
- Health, food, position
- Pickaxe count, food supply
- Inventory slots, nearby hostiles
- Mining task status

### Orient
Analyze threats and needs:
- Health < 10: CRITICAL - flee to safety
- Food < 10: Need to eat soon
- Pickaxes = 0: Must stop mining
- Free slots < 5: Dropoff needed
- Hostile mobs nearby: Danger

### Decide
Priority actions:
1. Health emergency → flee to start position
2. No pickaxes → stop and report
3. Low food → ensure bot eats
4. Inventory full → verify dropoff happening
5. All good → continue monitoring

### Act
Execute decision, then loop back to Observe.

---

## Current Status
- **Task ID:** task_6_1768106970733
- **Location:** Mining at Y=-59 (deepslate level) near z=-76440
- **Start Position:** Around (11440, -59, -76450)
- **Dropoff Chest:** (11415, -59, -76351)

---

## Pre-Mining Survey

**Always survey before mining to find unmined areas.**

```javascript
// Survey function - find unmined area by checking for solid blocks
async function surveyForUnminedArea() {
  const pos = bot.entity.position;
  const Vec3 = pos.constructor;
  const surveyRadius = 50;
  const directions = [
    { dx: 1, dz: 0, name: '+X' },
    { dx: -1, dz: 0, name: '-X' },
    { dx: 0, dz: 1, name: '+Z' },
    { dx: 0, dz: -1, name: '-Z' }
  ];

  const results = [];

  for (const dir of directions) {
    let solidCount = 0;
    let airCount = 0;

    // Check blocks along this direction
    for (let dist = 5; dist <= surveyRadius; dist += 5) {
      const checkPos = pos.offset(dir.dx * dist, 0, dir.dz * dist);
      const block = bot.blockAt(checkPos);
      if (block) {
        if (block.name.includes('deepslate') || block.name.includes('stone')) {
          solidCount++;
        } else if (block.name === 'air' || block.name === 'cave_air') {
          airCount++;
        }
      }
    }

    results.push({
      direction: dir.name,
      dx: dir.dx,
      dz: dir.dz,
      solidCount,
      airCount,
      score: solidCount - airCount // Higher = more unmined
    });
  }

  // Sort by score (most solid = least mined)
  results.sort((a, b) => b.score - a.score);
  return results;
}

// Usage: Survey and travel to best direction
const survey = await surveyForUnminedArea();
const best = survey[0];
console.log(`Best mining direction: ${best.direction} (score: ${best.score})`);

// Travel 30 blocks in best direction before starting
const travelDist = 30;
const newStart = bot.entity.position.offset(best.dx * travelDist, 0, best.dz * travelDist);
await bot.pathfinder.goto(new goals.GoalBlock(newStart.x, newStart.y, newStart.z));
```

---

## Goals
1. Strip mine at deepslate level (Y=-59) to find diamonds and other ores
2. Mine 30 tunnels, each 30 blocks long, with 3-block spacing between tunnels
3. Stay alive by avoiding lava and monitoring health
4. Auto-eat when food drops below 14
5. Auto-dropoff items at chest when inventory has 5 or fewer open slots
6. Keep pickaxes and food, deposit everything else

## Rules
1. **Lava Safety:** Check all 6 adjacent blocks before mining. Skip any block next to lava.
2. **Health Monitoring:** Stop if health drops below 10
3. **Mob Awareness:** Check for hostile mobs periodically
4. **Food Management:** Eat cooked beef or bread when food < 14
5. **Inventory Management:** Auto-dropoff when slots <= 5, keep pickaxes and food
6. **Pickaxe Management:** Always have a pickaxe equipped, stop when out of pickaxes

## Connection Details
```json
{
  "host": "centerbeam.proxy.rlwy.net",
  "port": 40387,
  "username": "fisherman",
  "auth": "offline"
}
```

## Mining Script

```javascript
// Clear any stuck pathfinder state first
bot.pathfinder.setGoal(null);

const startPos = bot.entity.position.clone();
const Vec3 = bot.entity.position.constructor;
const dropoffChest = new Vec3(11415, -59, -76351);

let totalMined = 0;
let tunnelsMined = 0;

async function equipPickaxe() {
  const picks = bot.inventory.items().filter(i => i.name.includes('pickaxe'));
  if (picks.length === 0) return false;
  await bot.equip(picks[0], 'hand');
  return true;
}

function isUnsafe(block) {
  if (!block) return false;
  return block.name === 'lava' || block.name === 'water' || block.name === 'flowing_lava' || block.name === 'flowing_water';
}

function checkForLava(pos) {
  const offsets = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of offsets) {
    const block = bot.blockAt(pos.offset(dx, dy, dz));
    if (isUnsafe(block)) return true;
  }
  return false;
}

async function safeDigBlock(pos) {
  const block = bot.blockAt(pos);
  if (!block || block.name === 'air' || block.name === 'bedrock') return false;
  if (checkForLava(pos)) return false;
  try {
    await bot.dig(block);
    totalMined++;
    return true;
  } catch (e) { return false; }
}

// PATCHED: Recursive pathfinding with intermediate waypoints
// When direct path fails, recursively try closer subgoals
async function safeGoto(goalPos, maxDepth = 4) {
  const pos = bot.entity.position;
  const targetVec = new Vec3(goalPos.x, goalPos.y, goalPos.z);

  async function tryPath(target, depth) {
    if (depth <= 0) return false;

    try {
      await bot.pathfinder.goto(new goals.GoalBlock(target.x, target.y, target.z));
      return true;
    } catch (e) {
      // Path failed - try intermediate waypoint
      const currentPos = bot.entity.position;
      const midpoint = new Vec3(
        Math.round((currentPos.x + target.x) / 2),
        Math.round((currentPos.y + target.y) / 2),
        Math.round((currentPos.z + target.z) / 2)
      );

      // Don't try if midpoint is too close to current position
      if (currentPos.distanceTo(midpoint) < 3) {
        console.log(`Can't find path, too close to try subgoal`);
        return false;
      }

      console.log(`Path failed, trying intermediate waypoint at ${midpoint} (depth ${depth})`);

      // Try to reach midpoint first
      const reachedMid = await tryPath(midpoint, depth - 1);
      if (reachedMid) {
        // Now try to reach final target from midpoint
        return await tryPath(target, depth - 1);
      }
      return false;
    }
  }

  return await tryPath(targetVec, maxDepth);
}

// Helper to create goal from position
function goalAt(pos) {
  return new goals.GoalBlock(pos.x, pos.y, pos.z);
}

// PATCHED: Scan for and mine valuable ores nearby
const VALUABLE_ORES = ['diamond_ore', 'deepslate_diamond_ore', 'gold_ore', 'deepslate_gold_ore',
  'emerald_ore', 'deepslate_emerald_ore', 'lapis_ore', 'deepslate_lapis_ore',
  'redstone_ore', 'deepslate_redstone_ore', 'coal_ore', 'deepslate_coal_ore',
  'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore'];

async function scanAndMineOres() {
  const pos = bot.entity.position;
  const radius = 4;
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      for (let z = -radius; z <= radius; z++) {
        const checkPos = pos.offset(x, y, z);
        const block = bot.blockAt(checkPos);
        if (block && VALUABLE_ORES.includes(block.name)) {
          if (!checkForLava(checkPos)) {
            console.log(`Found ${block.name} at ${checkPos}`);
            try {
              await bot.dig(block);
              totalMined++;
            } catch (e) {}
          }
        }
      }
    }
  }
}

async function dropoffItems() {
  const chestBlock = bot.blockAt(dropoffChest);
  if (!chestBlock || !chestBlock.name.includes('chest')) return;
  if (!await safeGoto(dropoffChest)) return;
  const chest = await bot.openContainer(chestBlock);
  const itemsToKeep = ['pickaxe', 'cooked', 'bread', 'steak', 'porkchop'];
  for (const item of bot.inventory.items()) {
    if (!itemsToKeep.some(k => item.name.includes(k))) {
      try { await chest.deposit(item.type, null, item.count); } catch (e) {}
    }
  }
  chest.close();
}

async function eatIfNeeded() {
  if (bot.food < 14) {
    const food = bot.inventory.items().find(i => i.name.includes('cooked') || i.name === 'bread');
    if (food) {
      await bot.equip(food, 'hand');
      await bot.consume();
      await equipPickaxe();
    }
  }
}

// Main mining loop
for (let t = 0; t < 30; t++) {
  if (bot.health < 10) return `Stopped: Low health (${bot.health})`;
  await eatIfNeeded();

  const openSlots = 36 - bot.inventory.items().length;
  if (openSlots <= 5) {
    await dropoffItems();
    await safeGoto(startPos.offset(0, 0, -t * 3));
  }

  const hostileMobs = Object.values(bot.entities).filter(e =>
    e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 10
  );
  if (hostileMobs.length > 0) {
    await safeGoto(startPos);
    await new Promise(r => setTimeout(r, 5000));
  }

  if (!await equipPickaxe()) return `Stopped: No pickaxes. Mined ${totalMined} blocks in ${tunnelsMined} tunnels.`;

  const tunnelZ = startPos.z - (t * 3);
  const tunnelStart = new Vec3(startPos.x, startPos.y, tunnelZ);
  const direction = (t % 2 === 0) ? 1 : -1;

  for (let i = 0; i < 30; i++) {
    const x = tunnelStart.x + (i * direction);
    const lower = new Vec3(x, tunnelStart.y, tunnelZ);
    const upper = new Vec3(x, tunnelStart.y + 1, tunnelZ);

    // PATCHED: Use recursive safeGoto with intermediate waypoints
    if (!await safeGoto(lower)) continue;
    // PATCHED: Scan for valuable ores before mining tunnel blocks
    await scanAndMineOres();
    await safeDigBlock(lower);
    await safeDigBlock(upper);
  }
  tunnelsMined++;
  console.log(`Tunnel ${tunnelsMined}/30 done. Blocks: ${totalMined}`);
}

return `Complete! Mined ${totalMined} blocks in ${tunnelsMined} tunnels.`;
```

## Quick Commands

### Connect
```javascript
// Use the connect MCP tool with:
// host: "centerbeam.proxy.rlwy.net"
// port: 40387
// username: "fisherman"
// auth: "offline"
```

### Check Status
```javascript
const pos = bot.entity.position;
const picks = bot.inventory.items().filter(i => i.name.includes('pickaxe'));
const usedSlots = bot.inventory.items().length;
const ores = bot.inventory.items().filter(i =>
  !i.name.includes('pickaxe') && !i.name.includes('cooked') && !i.name.includes('bread') &&
  (i.name.includes('diamond') || i.name.includes('gold') || i.name.includes('raw_') ||
   i.name.includes('lapis') || i.name.includes('redstone'))
);

return {
  pos: `(${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`,
  hp: bot.health,
  food: bot.food,
  picks: picks.reduce((s,p) => s+p.count, 0),
  slots: 36 - usedSlots,
  ores: ores.map(v => `${v.count}x ${v.name}`).join(', ') || 'none'
};
```

### Follow Player
```javascript
const player = bot.players['lmoik'];
if (player && player.entity) {
  bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
  return 'Following lmoik';
}
```

### Self-Defense Routine
```javascript
// Auto-attack hostile mobs within 5 blocks
const hostileTypes = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch',
  'phantom', 'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'ravager', 'warden',
  'zombie_villager', 'cave_spider', 'silverfish', 'slime', 'magma_cube', 'blaze', 'ghast'];

let defending = false;

async function defendSelf() {
  if (defending) return;

  const nearbyHostiles = Object.values(bot.entities).filter(e => {
    if (!e.type || !e.position) return false;
    const dist = e.position.distanceTo(bot.entity.position);
    return dist < 5 && hostileTypes.some(h => e.name?.includes(h));
  });

  if (nearbyHostiles.length > 0) {
    defending = true;
    const target = nearbyHostiles[0];

    try {
      // Equip sword if available, otherwise use pickaxe
      const sword = bot.inventory.items().find(i => i.name.includes('sword'));
      const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
      if (sword) await bot.equip(sword, 'hand');
      else if (pick) await bot.equip(pick, 'hand');

      // Attack the mob
      await bot.attack(target);
    } catch (e) {}

    defending = false;
  }
}

// Run defense check every 250ms
const defenseInterval = setInterval(defendSelf, 250);
bot._defenseInterval = defenseInterval;

return 'Self-defense routine active';
```

### Stop Self-Defense
```javascript
if (bot._defenseInterval) {
  clearInterval(bot._defenseInterval);
  bot._defenseInterval = null;
  return 'Self-defense stopped';
}
return 'No defense routine running';
```

### Stop Current Task
```javascript
bot.pathfinder.setGoal(null);
return 'Stopped';
```

## Notes
- The bot uses ESM modules, so `require()` doesn't work. Use `bot.entity.position.constructor` to get Vec3.
- Background tasks can interfere with navigation. Disconnect/reconnect to kill all tasks.
- The chest at (11415, -59, -76351) is near player lmoik's position in the mineshaft.

## Patch History

### 2026-01-11: Pathfinding Timeout Fix
**Bug:** `bot.pathfinder.goto()` throws "Took too long to decide path" error, crashing the mining task.
**Fix:** Added `safeGoto()` wrapper that catches pathfinding errors and continues to next position instead of crashing.

### 2026-01-11: Ore Prioritization
**Issue:** Bot walks past valuable ores without mining them.
**Fix:** Added `scanAndMineOres()` function that checks nearby blocks for valuable ores (diamond, gold, emerald, lapis, redstone, coal, iron, copper) and mines them before continuing.

### 2026-01-11: Recursive Pathfinding with Intermediate Waypoints
**Issue:** Pathfinder times out on long distances or complex terrain, causing bot to skip destinations.
**Fix:** Replaced simple `safeGoto()` with recursive version that:
1. Tries direct path first
2. On failure, calculates midpoint between current pos and target
3. Recursively tries to reach midpoint, then continues to target
4. Max depth of 4 levels prevents infinite recursion
5. Gives up if midpoint is < 3 blocks away (can't subdivide further)

### 2026-01-11: Self-Defense Routine
**Feature:** Added automatic self-defense against hostile mobs.
**Implementation:**
- Detects hostile mobs within 5 blocks (zombies, skeletons, spiders, creepers, etc.)
- Auto-equips sword if available, otherwise uses pickaxe
- Attacks threats automatically every 250ms
- Can be stopped with the "Stop Self-Defense" command
- Stored on `bot._defenseInterval` for cleanup

### 2026-01-11: Death by Creeper - Defense Loop Critical
**Bug:** Bot died to creeper while starting mining routine.
**Cause:** Agent disabled defense loop to prevent pathfinder conflicts, leaving bot unprotected.
**Lesson:** NEVER disable defense loop. It must run continuously.
**Fix:** Mining script must coexist with defense loop. If pathfinder conflicts occur, handle them in the mining script rather than disabling protection.

### 2026-01-11: Second Death - Defense Loop MUST Be First
**Bug:** Bot died again while trying to collect dropped items.
**Cause:** Agent forgot to start defense loop before moving the bot.
**Lesson:** ABSOLUTE RULE - The FIRST command after ANY respawn/teleport MUST be activating the defense loop. Before movement, before item collection, before ANYTHING.
**Mantra:** "Defense first, then act."
