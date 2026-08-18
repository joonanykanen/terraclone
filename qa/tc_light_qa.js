"use strict";
/* Lighting regression QA for the "dig a shaft and the top of the screen stays lit" bug.
   Drives the real game in headless Firefox (Marionette), digs a vertical shaft from the
   spawn surface, places the player at the bottom, and asserts:
     - shaft air decays with depth (dark ~13+ tiles below the surface)
     - when the view is fully underground, the TOP ROW of the view is dark (the reported bug)
     - the surface itself is still full-ambient (no over-darkening)
     - no page errors
   Run: node qa/tc_light_qa.js [path/to/index.html] */
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
    if (!Array.isArray(msg)) return;
    const [type, id, err, body] = msg;
    if (type === 1 && pending.has(id)) {
      const { res, rej, name } = pending.get(id); pending.delete(id);
      if (err) {
        const m = (typeof err === 'object' && err) ? (err.message || JSON.stringify(err)) : String(err);
        const st = (body && body.stacktrace) ? ' | ' + String(body.stacktrace).split('\n').slice(0, 2).join(' ') : '';
        rej(new Error(`${name}: ${m}${st}`));
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
    try {
      const v = await exec('return document.readyState==="complete" && !!window.TC;');
      if (v === true) { ready = true; break; }
    } catch (e) {}
    await sleep(300);
  }
  if (!ready) { console.error('GAME DID NOT BOOT. ff log tail:\n' + ffLog.slice(-1500)); ff.kill('SIGKILL'); process.exit(1); }
  console.log('game booted');

  await exec('window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(e.message+" @"+(e.lineno||"?"))});window.addEventListener("unhandledrejection",function(e){window.__errs.push("rejection: "+((e.reason&&e.reason.message)||e.reason))});return true;');
  await exec('TC.startNewWorld(0);return "ok";');
  await sleep(1200);

  // Shared page helpers.
  // __cleanCol(base,away,deep): a column with 12 empty rows above its surface (no trees) and,
  // when deep, solid floors at s+19/s+20 (19-deep shaft), s+47/s+48 (47-deep shaft) and s+59
  // (probe), with side columns c±2 solid from s+2 to s+60 (no side caves).
  const setup = `
    window.__placeFeet=function(c,R){var p=TC.player;p.x=c*16+4;p.y=R*16-24;p.vy=0;p.vx=0;p.apex=p.y;p.hp=100;p.dead=false;};
    window.__digShaft=function(c,from,to){for(var r=from;r<=to;r++)TC.setTile(c,r,0);};
    window.__viewTopRow=function(){return Math.floor(TC.camY/16)-1;};
    window.__cleanCol=function(base,away,deep){
      var W=400,Tc=TC;
      function solid(c,r){return r>=0&&r<200&&Tc.world[r*W+c]!==0&&Tc.world[r*W+c]!==11;}
      for(var off=0;off<=150;off++){var c=(base+((off%2)?off:-off));if(c<8||c>=392)continue;
      if(away&&Math.abs(c-away)<4)continue;
      var s=Tc.surf[c];if(s<24||s>120)continue;
      if(Tc.biome[c]===2)continue; // snow surface tile is porous (0.9 carry) — keep probes on grass/dirt/sand
      var ok=true;
      for(var r=s-12;r<s&&ok;r++){if(Tc.world[r*W+c]!==0)ok=false;}
      if(ok&&deep){
        var floors=[s+19,s+47,s+59];
        for(var i=0;i<floors.length&&ok;i++)if(!solid(c,floors[i]))ok=false;
        for(var dc=-2;dc<=2&&ok;dc+=4){for(var r=s+22;r<=s+26;r++){if(!solid(c+dc,r)){ok=false;break;}}}
      }
      if(ok)return c;}
      return -1;};
    return true;`;
  await exec(setup);

  const seed = await exec('return TC.SEED;');
  const c0 = await exec('return __cleanCol(TC.spawnCol,0,true);');
  if (c0 < 0) { console.error('no clean column found'); process.exit(1); }
  const surf = await exec('return TC.surf[' + c0 + '];');
  console.log('seed=' + seed + ' clean col=' + c0 + ' surface row=' + surf);

  const results = [];
  const check = (name, cond, detail) => {
    results.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
  };

  // ---- Scenario 1: 19-tile shaft, surface visible at top of screen (the user's screenshot case)
  await exec('TC.setGameTime(300*0.2);__digShaft(' + c0 + ',' + surf + ',' + (surf + 18) + ');__placeFeet(' + c0 + ',' + (surf + 19) + ');return "ok";');
  await sleep(1500);
  await shot('light_01_shaft_surface_visible');
  {
    const r = await exec(`return (function(){
      var s=${surf},x=${c0},y0=__viewTopRow(),out={y0:y0,surf:s};
      out.topAir=TC.lightAt((x-2)*16+8,(y0+1)*16+8);      // stone just below surface, top of screen
      out.shaft1=TC.lightAt(x*16+8,(s+1)*16+8);              // air 1 below surface
      out.shaft5=TC.lightAt(x*16+8,(s+5)*16+8);              // air 5 below surface
      out.shaft13=TC.lightAt(x*16+8,(s+13)*16+8);            // air 13 below surface
      out.stone25=TC.lightAt((x-2)*16+8,(s+25)*16+8);        // solid stone 25 below surface
      out.player=TC.lightAt(TC.player.x+6,TC.player.y+12);
      // full-ambient surface probe: nearest non-snow neighbor column whose surface is in view
      var pc=-1;
      for(var k=2;k<=8&&pc<0;k++){var cc=x+k;if(cc>=392)continue;if(TC.biome[cc]===2)continue;var ss=TC.surf[cc];if(Math.abs(ss-s)>3)continue;
        var clear=true;for(var r=ss-12;r<ss;r++){if(TC.world[r*400+cc]!==0){clear=false;break;}}if(clear)pc=cc;}
      out.surface=pc>0?TC.lightAt(pc*16+8,TC.surf[pc]*16+8):-1;
      for(var k in out)if(typeof out[k]==="number")out[k]=+out[k].toFixed(3);
      return JSON.stringify(out);})()`);
    const o = JSON.parse(r);
    console.log('shaft probe:', r);
    check('surface visible at top of view (scenario precondition)', o.y0 <= surf && o.y0 >= surf - 15, `y0-surf=${o.y0 - surf}`);
    check('shaft air near surface stays bright', o.shaft1 > 0.8 && o.shaft5 > 0.5, `1=${o.shaft1} 5=${o.shaft5}`);
    check('shaft air dark at 13 below surface', o.shaft13 < 0.15, `13=${o.shaft13}`);
    check('solid stone 25 below surface is dark', o.stone25 < 0.2, `stone25=${o.stone25}`);
    check('surface still full ambient', o.surface > 0.95, `surf=${o.surface}`);    check('player sees own light at shaft bottom', o.player > 0.3, `player=${o.player}`);
  }

  // ---- Scenario 2: 47-tile shaft, player at bottom, surface OFF-screen (view fully underground)
  await exec('TC.setGameTime(300*0.2);__digShaft(' + c0 + ',' + surf + ',' + (surf + 46) + ');__placeFeet(' + c0 + ',' + (surf + 47) + ');return "ok";');
  await sleep(1500);
  await shot('light_02_deep_view_top_underground');
  {
    const r = await exec(`return (function(){
      var s=${surf},x=${c0},y0=__viewTopRow(),out={y0:y0,depthBelowSurf:y0-s};
      out.topAir=TC.lightAt(x*16+8,y0*16+8);                // shaft air AT top view row
      out.stoneBelow=TC.lightAt(x*16+8,(s+59)*16+8);        // stone 12 below the shaft floor
      out.stoneSide=TC.lightAt((x-2)*16+8,(y0+2)*16+8);     // side stone near top of screen
      out.player=TC.lightAt(TC.player.x+6,TC.player.y+12);
      for(var k in out)if(typeof out[k]==="number")out[k]=+out[k].toFixed(3);
      return JSON.stringify(out);})()`);
    const o = JSON.parse(r);
    console.log('deep probe:', r);
    check('view top is below the surface (scenario precondition)', o.depthBelowSurf >= 12, `y0-surf=${o.depthBelowSurf}`);
    check('TOP OF SCREEN shaft air is dark underground (THE BUG)', o.topAir < 0.25, `top=${o.topAir}`);
    check('side stone near top of screen is dark', o.stoneSide < 0.25, `side=${o.stoneSide}`);
    check('stone below shaft floor is dark', o.stoneBelow < 0.25, `below=${o.stoneBelow}`);
    check('player still sees own light', o.player > 0.3, `player=${o.player}`);
  }

  // ---- Scenario 3: control — surface view unchanged (bright)
  const c3 = await exec('return __cleanCol(' + (c0 + 5) + ',' + c0 + ',false);');
  if (c3 < 0) { console.error('no second clean column found'); process.exit(1); }
  const s3 = await exec('return TC.surf[' + c3 + '];');
  await exec('TC.setGameTime(300*0.2);__placeFeet(' + c3 + ',' + s3 + ');return "ok";');
  await sleep(1500);
  await shot('light_03_surface_control');
  {
    const r = await exec(`return (function(){
      var x=${c3},s=TC.surf[x],out={surf:s};
      out.sky=TC.lightAt(x*16+8,(s-6)*16+8);
      out.grass=TC.lightAt(x*16+8,s*16+8);
      out.stone3=TC.lightAt(x*16+8,(s+3)*16+8);
      out.stone7=TC.lightAt(x*16+8,(s+7)*16+8);
      for(var k in out)if(typeof out[k]==="number")out[k]=+out[k].toFixed(3);return JSON.stringify(out);})()`);
    const o = JSON.parse(r);
    console.log('surface probe:', r);
    check('sky air full ambient', o.sky > 0.95, `sky=${o.sky}`);
    check('grass full ambient', o.grass > 0.95, `grass=${o.grass}`);
    check('stone 3 below surface moderately lit', o.stone3 > 0.4 && o.stone3 < 0.9, `stone3=${o.stone3}`);
    check('stone 7 below surface dim', o.stone7 >= 0 && o.stone7 < 0.2, `stone7=${o.stone7}`);
  }

  // ---- Scenario 4: night — shaft must be dark at night too (no stuck-bright band)
  await exec('TC.setGameTime(300*0.75);__placeFeet(' + c0 + ',' + (surf + 47) + ');return "ok";');
  await sleep(2500);
  await shot('light_04_deep_night');
  {
    const r = await exec(`return (function(){
      var y0=__viewTopRow(),x=${c0};
      return JSON.stringify({top:+TC.lightAt(x*16+8,y0*16+8).toFixed(3),amb:+TC.dayF.toFixed(3)});})()`);
    const o = JSON.parse(r);
    console.log('night probe:', r);
    check('top of screen dark underground at night', o.top < 0.1, `top=${o.top} (dayF=${o.amb})`);
  }

  // ---- Performance sanity: updateLight scans full columns now; make sure FPS holds up
  const fps = await exec(`return new Promise(function(res){var n=0;function f(){n++;if(n<120)requestAnimationFrame(f);else res(n/2);}requestAnimationFrame(f);});`);
  console.log('fps over 120 frames: ' + fps);
  check('fps healthy (>=45)', fps >= 45, 'fps=' + fps);

  const errs = await exec('return JSON.stringify(window.__errs||[]);');
  check('no page errors', errs === '[]', errs);

  console.log('\n=== RESULTS ===');
  let fails = 0;
  for (const line of results) { console.log(line); if (line.startsWith('FAIL')) fails++; }
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);

  try { send('WebDriver:DeleteSession', {}); } catch {}
  sock.destroy();
  ff.kill('SIGTERM');
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} process.exit(fails ? 1 : 0); }, 1500);
})().catch(e => { console.error('DRIVER FAILED:', e.message || e); try { sock.destroy(); } catch {} try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(1), 1000); });
