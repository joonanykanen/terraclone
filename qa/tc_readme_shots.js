"use strict";
/* README screenshot capture for TerraClone (headless Firefox + Marionette, same plumbing
   as tc_browser_qa.js). Writes 8 PNGs to ../screenshots/ (repo root):
     title, hero_day, hero_night (same landscape — used by the responsive <picture> hero),
     snow, underground, boss, inventory, saves.
   Run: node qa/tc_readme_shots.js [path/to/index.html]   (Node 24, no dependencies) */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const FIREFOX = '/Applications/Firefox Developer Edition.app/Contents/MacOS/Firefox';
const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const PORT = 2828;
const PROFILE = '/tmp/tc_ff_profile_' + Date.now();
const OUT = path.join(__dirname, '..', 'screenshots');
const url = 'file://' + FILE;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  try { execSync('pkill -f "Firefox.*--marionette" 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
  await sleep(500);

  console.log('launching headless firefox...');
  const ff = spawn(FIREFOX, ['--headless', '--marionette', '--width=1280', '--height=815',
    '-profile', PROFILE, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stdout.on('data', () => {});
  let ffLog = '';
  ff.stderr.on('data', d => { ffLog += d.toString(); });

  const start = Date.now();
  let up = false;
  while (Date.now() - start < 45000) {
    try { await new Promise((res, rej) => { const c = net.connect(PORT, '127.0.0.1'); c.on('connect', () => { c.end(); res(); }); c.on('error', rej); }); up = true; break; } catch {}
    await sleep(300);
  }
  if (!up) { console.error('FIREFOX DID NOT START:\n' + ffLog.slice(-2000)); ff.kill('SIGKILL'); process.exit(1); }
  console.log('marionette port up');

  const sock = await new Promise((res, rej) => { const s = net.connect(PORT, '127.0.0.1', () => res(s)); s.on('error', rej); setTimeout(() => rej(new Error('tcp timeout')), 5000); });

  let nextId = 1;
  const pending = new Map();
  let stream = Buffer.alloc(0);

  function handleMsg(msg) {
    if (!Array.isArray(msg)) { console.log('  (info msg:', JSON.stringify(msg).slice(0, 120), ')'); return; }
    const [type, id, err, body] = msg;
    if (type === 1 && pending.has(id)) {
      const { res, rej, name } = pending.get(id); pending.delete(id);
      if (err) rej(new Error(`${name}: ${(typeof err === 'object' && err) ? (err.message || JSON.stringify(err)) : String(err)}`));
      else res(body);
    }
  }
  sock.on('data', chunk => {
    stream = Buffer.concat([stream, chunk]);
    for (;;) {
      const ci = stream.indexOf(0x3a);
      if (ci < 0) break;
      const len = parseInt(stream.slice(0, ci).toString(), 10);
      if (!Number.isFinite(len) || len < 0) { console.error('bad frame header:', stream.slice(0, ci).toString()); break; }
      if (stream.length < ci + 1 + len) break;
      const json = stream.slice(ci + 1, ci + 1 + len).toString();
      stream = stream.slice(ci + 1 + len);
      try { handleMsg(JSON.parse(json)); } catch (e) { console.error('frame parse error:', e.message, json.slice(0, 100)); }
    }
  });
  sock.on('error', e => console.error('socket error:', e.message));

  function send(name, params) {
    return new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej, name });
      const j = Buffer.from(JSON.stringify([0, id, name, params]));
      sock.write(Buffer.from(j.length + ':' + j));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout: ' + name)); } }, 90000);
    });
  }

  async function exec(script) {
    const body = await send('WebDriver:ExecuteScript', { script, args: [] });
    return body && 'value' in body ? body.value : body;
  }

  async function shot(name) {
    const body = await send('WebDriver:TakeScreenshot', { full: false });
    let b64 = typeof body === 'string' ? body : (body && (body.value || body.data));
    if (typeof b64 !== 'string') throw new Error('screenshot: unexpected body ' + JSON.stringify(body).slice(0, 200));
    if (b64.startsWith('data:')) b64 = b64.slice(b64.indexOf(',') + 1);
    const p = `${OUT}/${name}.png`;
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    console.log('  shot -> ' + p + ' (' + Math.round(fs.statSync(p).size / 1024) + ' KB)');
  }

  await send('WebDriver:NewSession', { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
  await send('WebDriver:Navigate', { url });

  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await exec('return document.readyState==="complete" && !!window.TC;')) === true) { ready = true; break; } } catch (e) {}
    await sleep(300);
  }
  if (!ready) { console.error('GAME DID NOT BOOT. ff log tail:\n' + ffLog.slice(-1500)); ff.kill('SIGKILL'); process.exit(1); }
  console.log('game booted');

  await exec('window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(e.message+" @"+(e.lineno||"?"))});return true;');

  // teleport player to a column of the given biome (0=forest,1=desert,2=snow) with a clear, flat horizon
  const goBiome = (biome, timePh, flat) => {
    const range = flat > 2 ? 3 : 2;
    return 'return (function(){var best=-1,bd=999;'
      + 'for(var c=10;c<390;c++){if(TC.biome[c]!==' + biome + ')continue;var s=TC.surf[c];if(s<35||s>110)continue;var ok=true;'
      + 'for(var x=c-' + flat + ';ok&&x<=c+' + flat + ';x++){'
      + 'if(TC.biome[x]!==' + biome + ')ok=false;'
      + 'for(var r=TC.surf[x]-9;r<TC.surf[x];r++){var v=TC.world[r*400+x];if(v===5||v===6){ok=false;break;}}'
      + 'if(Math.abs(TC.surf[x]-s)>' + range + ')ok=false;}'
      + 'if(!ok)continue;var d=Math.abs(c-200);if(d<bd){bd=d;best=c;}}'
      + 'if(best<0)return "NO_BIOME";TC.setGameTime(300*' + timePh + ');'
      + 'var p=TC.player;p.x=best*16-6;p.y=TC.surf[best]*16-25;p.vy=0;p.vx=0;p.apex=p.y;p.hp=100;TC.mouse.x=-100;TC.mouse.y=-100;return "col"+best;})();';
  };

  /* 1. title (right after boot, no world yet) */
  await sleep(800);
  await shot('title');

  /* start one world and use it for all gameplay shots */
  await exec('return TC.startNewWorld(0)||"ok";');
  await sleep(1200);

  /* 2. hero day — forest, noon */
  console.log('hero_day setup:', await exec(goBiome(0, 0.20, 4)));
  await sleep(3400);
  await shot('hero_day');

  /* 3. hero night — SAME landscape, night (responsive hero pair) */
  await exec('TC.mouse.x=-100;TC.mouse.y=-100;TC.setGameTime(300*0.75);return "ok";');
  await sleep(2500);
  await shot('hero_night');

  /* 4. snow biome, day (no flat-horizon requirement — rolling snow is fine, just need a trunk-free player column) */
  console.log('snow setup:', await exec('return (function(){var best=-1,bd=999;for(var c=10;c<390;c++){if(TC.biome[c]!==2)continue;var s=TC.surf[c];if(s<35||s>110)continue;var ok=true;for(var r=s-9;r<s;r++){var v=TC.world[r*400+c];if(v===5||v===6){ok=false;break;}}if(!ok)continue;var d=Math.abs(c-200);if(d<bd){bd=d;best=c;}}if(best<0)return "NO_SNOW";TC.setGameTime(300*0.25);var p=TC.player;p.x=best*16-6;p.y=TC.surf[best]*16-25;p.vy=0;p.vx=0;p.apex=p.y;p.hp=100;TC.mouse.x=-100;TC.mouse.y=-100;return "col"+best;})();'));
  await sleep(3000);
  await shot('snow');

  /* 5. underground: torch-lit cave room with ore veins in the floor + a dug mining hole, night.
     Searches for a genuinely wide cave (air run >=8 tiles, >=10 below the local surface) with a
     5-wide flat floor and headroom; prefers rooms deep enough (depth >=25) that the surface/sky
     is outside the 45-tile-tall camera, so the shot is a bright enclosed chamber, not a hollow. */
  console.log('underground setup:', await exec('return (function(){' +
    'var Wd=400,cands=[];' +
    'for(var r=46;r<186;r++){var c=5;' +
    'while(c<Wd-5){' +
    'if(TC.world[r*Wd+c]!==0){c++;continue;}' +
    'var c0=c;while(c<Wd-5&&TC.world[r*Wd+c]===0)c++;var w=c-c0;' +
    'if(w>=8){var bestF=-1,bestD=1e9,runC=c0+w/2;' +
    'for(var x=c0;x+4<c;x++){var s=true;for(var k=0;k<5;k++)if(TC.world[(r+1)*Wd+x+k]===0)s=false;if(!s)continue;var dd=Math.abs(x+2-runC);if(dd<bestD){bestD=dd;bestF=x;}}' +
    'if(bestF>=0){var pc=bestF+2;' +
    'var depth=r-TC.surf[pc];' +
    'if(depth>=10&&TC.world[(r-1)*Wd+pc]===0){var hh=0;for(var hr=r-1;hr>=r-4&&TC.world[hr*Wd+pc]===0;hr--)hh++;cands.push({x:bestF,r:r,w:w,hh:hh,depth:depth,d:Math.abs(pc-200)});}}}}}' +
    'function pickBest(md,mw,mh){var b=null;cands.forEach(function(k){if(k.depth>=md&&k.w>=mw&&k.hh>=mh&&(b===null||k.d<b.d))b=k;});return b;}' +
    'var pick=pickBest(25,12,2)||pickBest(25,8,2)||pickBest(25,12,1)||pickBest(25,8,1)'+
    '||pickBest(18,12,2)||pickBest(18,8,2)||pickBest(18,12,1)||pickBest(18,8,1)'+
    '||pickBest(12,12,1)||pickBest(12,8,1)||null;' +
    'if(!pick)return "NO_ROOM";' +
    'var fx=pick.x,r=pick.r,pc=fx+2,deep=r>148,mid=r>100;' +
    'TC.setTile(pc-2,r,11);              /* torch on the floor, left of the player */' +
    'TC.setTile(pc-1,r+1,7);             /* iron vein in the floor, between the torches */' +
    'TC.setTile(pc+1,r+1,0);             /* dig a mining notch in the floor */' +
    'TC.setTile(pc+1,r+2,deep?9:8);      /* gold/diamond at the bottom of the hole */' +
    'TC.setTile(pc+2,r+1,mid?8:7);       /* gold (or iron) vein under the torch */' +
    'TC.setTile(pc+2,r,11);              /* torch on the floor, right of the hole */' +
    'TC.setGameTime(300*0.78);' +
    'var p=TC.player;p.x=pc*16+2;p.y=r*16-8;p.vy=0;p.vx=0;p.face=1;p.apex=p.y;p.hp=100;TC.mouse.x=-100;TC.mouse.y=-100;' +
    'return "room pc="+pc+" r="+r+" w="+pick.w+" hh="+pick.hh+" depth="+pick.depth;})();'));
  await sleep(1500);
  await shot('underground');

  /* 6. boss fight, night — back on the surface (shot 5 left the player in a cave).
     Player geared up: full diamond armor (bright cyan reads against the dark night,
     contrasts the purple king) + diamond sword in the hotbar. */
  console.log('boss setup:', await exec(goBiome(0, 0.75, 4)));
  await sleep(600);
  await exec('return (function(){var i=TC.inv;i[50]={id:"armor_dia_helm",count:1};i[51]={id:"armor_dia_chest",count:1};i[52]={id:"armor_dia_legs",count:1};i[0]={id:"sword_dia",count:1};i[1]={id:"potion_greater",count:3};TC.setSelected(0);TC.setUI(false);TC.spawnBoss();return "summoned";})();');
  await sleep(3800);
  await shot('boss');

  /* 7. inventory & crafting UI, day, clean background (clear the boss from shot 6). */
  /* NOTE: empty the live entities array rather than flagging dead — while the UI is open,
     update() skips updateEntities, so dead entities are never spliced and would keep rendering. */
  console.log('inventory setup:', await exec(goBiome(0, 0.20, 4)));
  await exec('return (function(){TC.entities.length=0;TC.setUI(false);var i=TC.inv;var p=TC.player;p.hp=100;' +
    'i[0]={id:"pick_iron",count:1};i[1]={id:"sword_iron",count:1};i[2]={id:"torch",count:16};i[3]={id:"gel",count:15};i[4]={id:"iron_bar",count:5};i[5]={id:"wood",count:30};i[6]={id:"potion",count:3};' +
    'for(var k=7;k<10;k++)i[k]=null;for(var m=10;m<50;m++)i[m]=null;' +
    'i[10]={id:"iron_ore",count:20};i[11]={id:"potion_greater",count:2};i[12]={id:"crown",count:1};' +
    'i[50]={id:"armor_iron_helm",count:1};i[51]={id:"armor_iron_chest",count:1};i[52]={id:"armor_iron_legs",count:1};' +
    'TC.setSelected(0);TC.setUI(true);return "ok";})();');
  await sleep(700);
  await shot('inventory');

  /* 8. save-select with two filled slots (slot 1: day 2, slot 2: day 1) */
  await exec('TC.setUI(false);TC.setGameTime(300*1.35);return "ok";');
  await sleep(300);
  await exec('TC.saveSlot(0);return "saved0";');
  await exec('return TC.startNewWorld(1)||"ok";');
  await sleep(600);
  await exec('TC.saveSlot(1);TC.setMenuState("saveSelect");return "ok";');
  await sleep(500);
  await shot('saves');

  console.log('pageErrors:', JSON.stringify(await exec('return JSON.stringify(window.__errs||[]);')));

  try { send('WebDriver:DeleteSession', {}); } catch {}
  sock.destroy();
  ff.kill('SIGTERM');
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} process.exit(0); }, 1500);
})().catch(e => { console.error('DRIVER FAILED:', e.message || e); try { sock.destroy(); } catch {} try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(1), 1000); });
