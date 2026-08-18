"use strict";
/* King Slime difficulty QA for index.html.
   Run: node qa/tc_boss_qa.js [path/to/index.html] -> shot in qa/shots/boss2.png
   Verifies the re-balanced boss: 950 HP, 44 contact dmg, half-armor boss damage,
   gel spit projectiles (swattable), landing shockwave, 30% enrage, coin+gel drops,
   save/load of a live boss, no page errors. */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const FIREFOX = '/Applications/Firefox Developer Edition.app/Contents/MacOS/Firefox';
const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const PORT = 2828;
const PROFILE = '/tmp/tc_ff_profile_' + Date.now();
const OUT = path.join(__dirname, 'shots');
const url = 'file://' + FILE;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  try { execSync('pkill -f "tc_ff_profile" 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
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
    if (!Array.isArray(msg)) return;
    const [type, id, err, body] = msg;
    if (type === 1 && pending.has(id)) {
      const { res, rej, name } = pending.get(id); pending.delete(id);
      if (err) {
        const m = (typeof err === 'object' && err) ? (err.message || JSON.stringify(err)) : String(err);
        rej(new Error(`${name}: ${m}`));
      } else res(body);
    }
  }
  sock.on('data', chunk => {
    stream = Buffer.concat([stream, chunk]);
    for (;;) {
      const ci = stream.indexOf(0x3a);
      if (ci < 0) break;
      const len = parseInt(stream.slice(0, ci).toString(), 10);
      if (!Number.isFinite(len) || len < 0) break;
      if (stream.length < ci + 1 + len) break;
      const json = stream.slice(ci + 1, ci + 1 + len).toString();
      stream = stream.slice(ci + 1 + len);
      try { handleMsg(JSON.parse(json)); } catch (e) {}
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
    if (typeof b64 !== 'string') throw new Error('screenshot: unexpected body');
    if (b64.startsWith('data:')) b64 = b64.slice(b64.indexOf(',') + 1);
    const p = `${OUT}/${name}.png`;
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    console.log('  shot -> ' + p + ' (' + Math.round(fs.statSync(p).size / 1024) + ' KB)');
  }

  await send('WebDriver:NewSession', { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
  await send('WebDriver:Navigate', { url });

  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      ready = (await exec('return document.readyState==="complete" && !!window.TC;')) === true;
      if (ready) break;
    } catch (e) {}
    await sleep(300);
  }
  if (!ready) { console.error('GAME DID NOT BOOT. ff log tail:\n' + ffLog.slice(-1500)); ff.kill('SIGKILL'); process.exit(1); }
  console.log('game booted (window.TC present)');

  await exec('window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(e.message+" @"+(e.lineno||"?"))});window.addEventListener("unhandledrejection",function(e){window.__errs.push("rejection: "+((e.reason&&e.reason.message)||e.reason))});return true;');

  /* helper: put player on flat ground near the boss (same surface height) at ~dist px, direction -1/+1 */
  const STAGE = 'window.__stage=function(dist,dir){var k=null;TC.entities.forEach(function(e){if(e.type==="king"&&!e.dead)k=e;});if(!k)return "no boss";var colK=Math.floor((k.x+k.w/2)/16),sK=TC.surf[colK];var best=-1;for(var d=2;d<=32;d++){var c=colK+dir*d;if(c<1||c>=399)break;if(Math.abs(TC.surf[c]-sK)<=1){if(best<0)best=c;if(Math.abs(d*16-dist)<=10){best=c;break;}}}if(best<0)return "no flat ground";var p=TC.player;p.x=best*16-6;p.y=TC.surf[best]*16-25;p.vx=0;p.vy=0;p.face=dir>0?1:-1;p.apex=p.y;p.hp=100;p.inv=0;p.dead=false;p.hurtCd=99;return "staged dist~"+(Math.abs(best-colK)*16)+"px";};' +
    'window.__killOther=function(){TC.entities.forEach(function(e){if(e.type!=="king")e.dead=true;});return TC.entities.length;};return "helpers ok";';
  console.log('  helpers:', await exec(STAGE));
  await exec('return TC.startNewWorld(0)||"ok";');
  await sleep(800);
  await exec(STAGE); // re-register helpers (world reset does not clear window, but be safe)

  /* ---- 1. boss stats ---- */
  await exec('return TC.spawnBoss();');
  await sleep(300);
  const stats = await exec('return (function(){var k=null;TC.entities.forEach(function(e){if(e.type==="king")k=e;});return k?{hp:k.hp,maxhp:k.maxhp,dmg:k.dmg,spitT:k.spitT,enraged:k.enraged,c1:k.c1}:null;})();');
  console.log('  boss stats:', JSON.stringify(stats));
  check('boss spawns with 950 HP', stats && stats.hp === 950 && stats.maxhp === 950);
  check('boss contact dmg is 44', stats && stats.dmg === 44);
  check('boss has spit timer + not enraged', stats && typeof stats.spitT === 'number' && stats.enraged === false);

  /* ---- 2. live fight, NO armor: player must be in serious danger ---- */
  await exec('return __stage(260,1)+";"+__killOther();');
  await exec('window.__min=100;window.__died=false;window.__sawProj=false;window.__int=setInterval(function(){var p=TC.player;if(TC.projs.length>0)window.__sawProj=true;if(!p.dead){if(p.hp<window.__min)window.__min=p.hp;}else window.__died=true;},120);return "sampling";');
  await sleep(1000);
  await shot('boss2');
  await sleep(6500);
  await exec('clearInterval(window.__int);return true;');
  const fight = await exec('return {min:window.__min,died:window.__died,sawProj:window.__sawProj,hp:TC.player.hp,dead:TC.player.dead};');
  console.log('  no-armor fight:', JSON.stringify(fight));
  check('player saw gel spits during fight', fight.sawProj === true);
  check('no-armor player is in real danger (min hp < 60 or died)', fight.min < 60 || fight.died === true, 'min=' + fight.min + ' died=' + fight.died);

  /* ---- 3. boss damage ignores half armor (wither-style) ---- */
  await exec('return (function(){var inv=TC.inv;inv[50]={id:"armor_dia_helm",count:1};inv[51]={id:"armor_dia_chest",count:1};inv[52]={id:"armor_dia_legs",count:1};var p=TC.player;p.hp=100;p.inv=0;p.dead=false;return "dia equipped";})();');
  await exec('return __stage(120,1)+";"+__killOther();');
  const armA = await exec('return (function(){var p=TC.player;TC.hurtPlayer(44,p.x+1,true);return p.hp;})();');
  check('diamond: contact 44 -> 33 taken (half def 22)', armA === 67, 'hp=' + armA);
  const armB = await exec('return (function(){var p=TC.player;p.hp=100;p.inv=0;TC.hurtPlayer(22,p.x+1,true);return p.hp;})();');
  check('diamond: spit 22 -> 11 taken', armB === 89, 'hp=' + armB);
  const armC = await exec('return (function(){var p=TC.player;p.hp=100;p.inv=0;TC.hurtPlayer(12,p.x+1,false);return p.hp;})();');
  check('non-boss damage still fully mitigated (12 vs def 22 -> 1)', armC === 99, 'hp=' + armC);

  /* ---- 4. enrage at 30% ---- */
  await exec('return (function(){var k=null;TC.entities.forEach(function(e){if(e.type==="king")k=e;});k.hp=280;return "hp set";})();');
  await sleep(600);
  const enr = await exec('return (function(){var k=null;TC.entities.forEach(function(e){if(e.type==="king")k=e;});return k?{enraged:k.enraged,dmgM:k.dmgM,c1:k.c1}:null;})();');
  console.log('  enrage state:', JSON.stringify(enr));
  check('enrages below 30% HP', enr && enr.enraged === true && enr.dmgM === 1.15);
  check('enraged boss turns red', enr && enr.c1 === '#e05a76');

  /* ---- 5. melee can swat a gel spit (boss parked & frozen far away) ---- */
  await exec('return __stage(100,1)+";"+__killOther();');
  await exec('return (function(){var k=null;TC.entities.forEach(function(e){if(e.type==="king")k=e;});var p=TC.player;k.x=Math.max(100,Math.min(6200,p.x-900));k.y=p.y-60;k.vx=0;k.vy=0;k.t=1e9;k.spitT=1e9;p.hp=100;p.inv=0;p.dead=false;p.vx=0;p.vy=0;TC.projs.length=0;TC.projs.push({x:p.x+30,y:p.y+4,vx:0,vy:0,dmg:22,t:3});return "ready projs="+TC.projs.length;})();');
  await sleep(100);
  await exec('return TC.mouse.l=true;');
  await sleep(250);
  await exec('return TC.mouse.l=false;');
  const swat = await exec('return TC.projs.length;');
  check('sword swing swats gel spit out of the air', swat === 0, 'projs left=' + swat);

  /* ---- 6. killing the boss drops coins AND gel ---- */
  await exec('return (function(){TC.drops.length=0;var k=null;TC.entities.forEach(function(e){if(e.type==="king")k=e;});k.hp=1;TC.killEntity(k);return "killed";})();');
  await sleep(400);
  const drops = await exec('return TC.drops.map(function(d){return d.item;});');
  const dCount = {};
  drops.forEach(d => { dCount[d] = (dCount[d] || 0) + 1; });
  console.log('  boss drops:', JSON.stringify(dCount));
  check('boss drops coins (>=8)', (dCount.coin || 0) >= 8, 'coins=' + (dCount.coin || 0));
  check('boss drops gel (3-5) for potions', (dCount.gel || 0) >= 3 && (dCount.gel || 0) <= 5, 'gel=' + (dCount.gel || 0));
  const note = await exec('return TC.notes.map(function(n){return n.text;}).join(" | ");');
  check('defeat notification shown', note.indexOf('defeated') >= 0, note.slice(0, 80));

  /* ---- 7. save/load keeps the new boss stats on a live boss ---- */
  await exec('return TC.spawnBoss();');
  await sleep(300);
  await exec('return TC.saveSlot(0);');
  await exec('return TC.loadSlot(0)||"ok";');
  await sleep(500);
  const loaded = await exec('return (function(){var k=null;TC.entities.forEach(function(e){if(e.type==="king")k=e;});return k?{hp:k.hp,maxhp:k.maxhp,dmg:k.dmg,spitT:typeof k.spitT,enraged:k.enraged}:null;})();');
  console.log('  reloaded boss:', JSON.stringify(loaded));
  check('loaded boss keeps 950 maxhp / 44 dmg / spitT', loaded && loaded.maxhp === 950 && loaded.dmg === 44 && loaded.spitT === 'number');

  /* ---- final ---- */
  const pageErrors = await exec('return JSON.stringify(window.__errs||[]);');
  check('no page errors', pageErrors === '[]' || pageErrors === 'null', pageErrors);

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');

  try { send('WebDriver:DeleteSession', {}); } catch {}
  sock.destroy();
  ff.kill('SIGTERM');
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} process.exit(fail > 0 ? 1 : 0); }, 1500);
})().catch(e => { console.error('DRIVER FAILED:', e.message || e); try { sock.destroy(); } catch {} try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(1), 1000); });
