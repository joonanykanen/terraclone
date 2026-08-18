# qa/ — browser test harnesses

Headless **Firefox Developer Edition** driven via **Marionette** (protocol 3: length-prefixed JSON over raw TCP on port 2828) from **Node 24, zero dependencies**. Requires Firefox at `/Applications/Firefox Developer Edition.app` (path configurable at the top of each script).

| Script | What it does | Run |
|---|---|---|
| `tc_browser_qa.js` | Visual scenario shots (day/night, biomes, torch lighting, boss, inventory, death screen) + checks report (dayF ramp, light gradient, entities, page errors) | `node qa/tc_browser_qa.js` |
| `tc_save_qa.js` | 3-slot save/load suite — 19 checks: menu flow, click + F5 + pause-menu saves, full state restore fidelity, delete, all-slots-full routing | `node qa/tc_save_qa.js` |
| `tc_armor_qa.js` | Worn-armor model — 10 checks: pixel-samples the player sprite with iron/gold/dia helm/chest/legs (full + per-piece sets), face/belt stay visible, jump + walk frames pick up the tint | `node qa/tc_armor_qa.js` |
| `tc_boss_qa.js` | King Slime difficulty — 17 checks: 950 HP / 44 contact dmg, half-armor boss damage, swattable gel spits, landing shockwave, 30% enrage, coin+gel drops, save/load of a live boss, page errors. The no-armor fight check is deterministic: it freezes the boss on clear ground, stages the player 208-464 px away with verified line of sight (carving or leveling the terrain via setTile when it blocks), and snaps the player back after knockback, so every aimed spit lands | `node qa/tc_boss_qa.js` |
| `tc_readme_shots.js` | Captures the 8 README screenshots into `screenshots/` | `node qa/tc_readme_shots.js` |

All scripts take an optional `index.html` path argument (default: repo root).

**Marionette gotchas** (learned the hard way — keep when extending):
- `executeScript` scripts are **function bodies**: explicit `return` required; result in `body.value`.
- The script sandbox sees `window` properties but **not** top-level `let`/`const` → always go through the `window.TC` debug API.
- `--height=815` yields a ~730px viewport (1:1 1280×720 canvas); `--height=720` letterboxes to 635px.
- Real user gestures don't exist in headless: Web Audio state checks should tolerate a suspended `AudioContext`.
- A **stray marionette Firefox holds port 2828** and every new run silently drives *it* (stale page state, dirty localStorage) instead of dying: the startup `pkill` must match the actual launch line (`pkill -f "Firefox.*--marionette"`), not just the profile-name prefix — a foreign profile (e.g. `/tmp/tc_ff_dbg_*`) slipped through `pkill -f "tc_ff_profile"` once and broke the save suite for hours.
