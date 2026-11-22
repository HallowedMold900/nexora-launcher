const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard, nativeImage, nativeTheme } = require('electron');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(app.getPath('appData'), '.nexora');
const CFG = path.join(ROOT, 'launcher.json');
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const plat = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];
const exe = process.platform === 'win32' ? 'java.exe' : 'java';
let win;

const getJson = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
async function download(url, dest) {
  if (fs.existsSync(dest)) return;
  if (!url) throw new Error('Нет файла: ' + dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`);
  fs.writeFileSync(dest + '.part', Buffer.from(await r.arrayBuffer()));
  fs.renameSync(dest + '.part', dest);
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}
const allowed = rules => !rules || rules.reduce((a, r) => {
  const m = !r.features && (!r.os || ((!r.os.name || r.os.name === plat) && r.os.arch !== 'x86'));
  return m ? r.action === 'allow' : a;
}, false);
const offlineUuid = nick => {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + nick).digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

/* ---------- Автоопределение Java (как в Prism: JAVA_HOME, PATH, типичные папки) ---------- */
const CUSTOM = path.join(ROOT, 'java-custom.json');
const readCustom = () => { try { return JSON.parse(fs.readFileSync(CUSTOM, 'utf8')); } catch { return []; } };
function scanDir(d, depth, add) {
  for (const sub of ['bin', 'Contents/Home/bin']) { const p = path.join(d, sub, exe); if (fs.existsSync(p)) return add(p); }
  if (depth <= 0) return;
  let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of list) if (e.isDirectory() || e.isSymbolicLink()) scanDir(path.join(d, e.name), depth - 1, add);
}
const regQuery = key => new Promise(res => execFile('reg', ['query', key, '/s'], { timeout: 8000, maxBuffer: 1 << 24 }, (e, so) => res(String(so || ''))));
async function javaCandidates() {
  const c = new Set(), add = p => p && c.add(p), home = os.homedir(), env = process.env;
  if (env.JAVA_HOME) add(path.join(env.JAVA_HOME, 'bin', exe));
  add(exe);
  const dirs = [[path.join(ROOT, 'java'), 3], [path.join(home, '.jdks'), 2], [path.join(home, '.gradle/jdks'), 2], [path.join(home, '.sdkman/candidates/java'), 2], [path.join(home, '.asdf/installs/java'), 2]];
  if (process.platform === 'win32') {
    for (const b of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')])
      if (b) for (const v of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'AdoptOpenJDK', 'Oracle', 'GraalVM', 'OpenJDK', 'Temurin', 'JetBrains', 'Android', 'Common Files/Oracle/Java']) dirs.push([path.join(b, v), 3]);
    if (env.APPDATA) dirs.push([path.join(env.APPDATA, '.minecraft/runtime'), 4]);
    if (env.LOCALAPPDATA) dirs.push([path.join(env.LOCALAPPDATA, 'Packages/Microsoft.4297127D64EC6_8wekyb3d8bbwe/LocalCache/Local/runtime'), 4]);
    const keys = ['JavaSoft', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft\\JDK', 'Azul Systems', 'BellSoft', 'Amazon Corretto'];
    const out = await Promise.all(keys.flatMap(k => [`HKLM\\SOFTWARE\\${k}`, `HKLM\\SOFTWARE\\WOW6432Node\\${k}`]).map(regQuery));
    for (const t of out) for (const m of t.matchAll(/REG_SZ\s+([A-Za-z]:\\.+)$/gm)) scanDir(m[1].trim(), 0, add);
  } else {
    dirs.push(['/usr/lib/jvm', 2], ['/usr/lib64/jvm', 2], ['/usr/local/lib/jvm', 2], ['/opt/java', 2], ['/opt', 1], ['/Library/Java/JavaVirtualMachines', 2],
      [path.join(home, 'Library/Java/JavaVirtualMachines'), 2], ['/opt/homebrew/opt', 1], ['/usr/local/opt', 1]);
  }
  for (const [d, depth] of dirs) scanDir(d, depth, add);
  readCustom().forEach(add);
  return [...c];
}
const run = (p, args) => new Promise(res => execFile(p, args, { timeout: 15000, windowsHide: true }, (e, so, se) => res({ out: String(se) + '\n' + String(so), e })));
// Основа — обычный `java -version` (работает у всех версий), `-XshowSettings` лишь уточняет данные
async function probe(p) {
  const v = await run(p, ['-version']);
  const m = v.out.match(/version "([^"]+)"/);
  if (!m) return { error: (v.e?.message || v.out).trim().slice(0, 200) };
  const version = m[1];
  const st = await run(p, ['-XshowSettings:property', '-version']);
  const g = k => (st.out.match(new RegExp('\\s' + k.replace(/\./g, '\\.') + ' = (.+)')) || [])[1]?.trim();
  const home = g('java.home') || (/[\\/]bin$/.test(path.dirname(p)) ? path.dirname(path.dirname(p)) : p);
  const full = path.join(home, 'bin', exe);
  return { path: fs.existsSync(full) ? full : p, home, version, vendor: g('java.vendor'),
    arch: g('os.arch') || (/64-Bit/i.test(v.out) ? 'x64' : 'x86'),
    major: version.startsWith('1.') ? +version.split('.')[1] : parseInt(version) };
}
let javaCache;
async function findJava(force) {
  if (javaCache && !force) return javaCache;
  const found = new Map();
  await pool(await javaCandidates(), 4, async p => { const r = await probe(p); if (r.version && !found.has(r.home)) found.set(r.home, r); });
  return (javaCache = [...found.values()].sort((a, b) => b.major - a.major));
}
// точное совпадение версии, иначе ближайшая более новая
const pickJava = (list, need) => list.filter(j => j.major >= need)
  .sort((a, b) => (a.major !== need) - (b.major !== need) || a.major - b.major)[0];

/* ---------- Загрузчики ---------- */
const mvn = n => { const [g, a, v, c] = n.split(':'); return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${c ? '-' + c : ''}.jar`; };
const artOf = l => l.downloads?.artifact || { path: mvn(l.name), url: l.url ? l.url + mvn(l.name) : '' };
const libKey = l => { const [g, a, , c] = l.name.split(':'); return g + ':' + a + (c ? ':' + c : ''); };
function merge(p, c) {
  const m = new Map(); [...p.libraries, ...(c.libraries || [])].forEach(l => m.set(libKey(l), l));
  return {
    ...p, ...c, libraries: [...m.values()], assetIndex: p.assetIndex, downloads: p.downloads, javaVersion: p.javaVersion,
    arguments: { jvm: [...(p.arguments.jvm || []), ...(c.arguments?.jvm || [])], game: [...(p.arguments.game || []), ...(c.arguments?.game || [])] }
  };
}
async function installForge(L, id, java, log, lver) {
  let ver, url, vid;
  if (L === 'forge') {
    const pr = (await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
    ver = lver || pr[id + '-recommended'] || pr[id + '-latest'];
    if (!ver) throw new Error('Загрузчик {0} недоступен для этой версии|Forge');
    url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${id}-${ver}/forge-${id}-${ver}-installer.jar`; vid = `${id}-forge-${ver}`;
  } else {
    const [, a, b] = id.split('.'), pre = `${a}.${b || 0}.`;
    const all = (await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions.filter(x => x.startsWith(pre) && !x.includes('-'));
    ver = lver || all.pop();
    if (!ver) throw new Error('Загрузчик {0} недоступен для этой версии|NeoForge');
    url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`; vid = `neoforge-${ver}`;
  }
  const jf = path.join(ROOT, 'versions', vid, vid + '.json');
  if (!fs.existsSync(jf)) {
    const inst = path.join(ROOT, 'installers', path.basename(url)); await download(url, inst);
    const lp = path.join(ROOT, 'launcher_profiles.json'); if (!fs.existsSync(lp)) fs.writeFileSync(lp, '{"profiles":{}}');
    await new Promise((res, rej) => {
      const p = spawn(java, ['-jar', inst, '--installClient', ROOT], { cwd: ROOT });
      p.stdout.on('data', d => log(String(d).trimEnd())); p.stderr.on('data', d => log(String(d).trimEnd()));
      p.on('error', rej); p.on('close', c => c ? rej(new Error('Не удалось установить загрузчик (код {0})|' + c)) : res());
    });
    if (!fs.existsSync(jf)) throw new Error('Не удалось установить загрузчик (код {0})|?');
  }
  return JSON.parse(fs.readFileSync(jf, 'utf8'));
}

/* ---------- Запуск ---------- */
const running = new Map(); // pid сборки -> процесс игры
const sendRunning = () => win?.webContents.send('running', [...running.keys()]);
async function launch({ lver, id, pid, name, nick, ram, jvm, loader, java: jsel, ww, wh, fullscreen }) {
  const send = (s, p) => win.webContents.send('progress', s, p), log = t => win.webContents.send('log', t);
  const m = await getJson(MANIFEST), e = m.versions.find(v => v.id === id);
  if (!e) throw new Error('Версия не найдена');
  send('Описание версии', 2);
  const base = await getJson(e.url);
  if (!base.arguments) throw new Error('Версии старше 1.19 пока не поддерживаются');
  const need = base.javaVersion?.majorVersion || 17;
  const java = jsel && jsel !== 'auto' ? jsel : pickJava(await findJava(), need)?.path;
  if (!java) throw new Error('Java не найдена. Нужна Java {0}|' + need);
  const A = await launchAuth();

  const vdir = path.join(ROOT, 'versions', id), jar = path.join(vdir, id + '.jar');
  fs.mkdirSync(vdir, { recursive: true }); fs.writeFileSync(path.join(vdir, id + '.json'), JSON.stringify(base));
  send('Загрузка клиента', 5); await download(base.downloads.client.url, jar);

  let v = base;
  if (loader !== 'Vanilla') {
    send('Установка загрузчика', 8);
    const L = loader.toLowerCase(); let child;
    if (L === 'fabric' || L === 'quilt') {
      const b = L === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
      const lv = await getJson(`${b}/versions/loader/${id}`);
      if (!lv.length) throw new Error('Загрузчик {0} недоступен для этой версии|' + loader);
      const lid = lver || (lv.find(x => x.loader.stable !== false) || lv[0]).loader.version;
      child = await getJson(`${b}/versions/loader/${id}/${lid}/profile/json`);
    } else child = await installForge(L, id, java, log, lver);
    v = merge(base, child);
  }
  const libs = v.libraries.filter(l => allowed(l.rules));
  if (libs.some(l => l.natives)) throw new Error('Версии старше 1.19 пока не поддерживаются');
  const arts = libs.map(artOf); let n = 0;
  await pool(arts, 8, async a => { await download(a.url, path.join(ROOT, 'libraries', a.path)); send('Загрузка библиотек', 10 + 25 * ++n / arts.length); });

  const index = await getJson(base.assetIndex.url);
  const ip = path.join(ROOT, 'assets', 'indexes', base.assetIndex.id + '.json');
  fs.mkdirSync(path.dirname(ip), { recursive: true }); fs.writeFileSync(ip, JSON.stringify(index));
  const objs = Object.values(index.objects); n = 0;
  await pool(objs, 16, async o => {
    const h = o.hash.slice(0, 2) + '/' + o.hash;
    await download('https://resources.download.minecraft.net/' + h, path.join(ROOT, 'assets', 'objects', h));
    if (++n % 50 === 0) send('Загрузка ассетов', 35 + 60 * n / objs.length);
  });
  send('Запуск игры', 98);

  const gameDir = inst(pid);
  const natives = path.join(vdir, 'natives');
  fs.mkdirSync(gameDir, { recursive: true }); fs.mkdirSync(natives, { recursive: true });
  const cp = [...new Set([...arts.map(a => path.join(ROOT, 'libraries', a.path)), jar])].join(path.delimiter);
  const vars = {
    auth_player_name: A ? A.name : nick, version_name: v.id, game_directory: gameDir, assets_root: path.join(ROOT, 'assets'),
    assets_index_name: base.assetIndex.id, auth_uuid: A ? A.uuid : offlineUuid(nick), auth_access_token: A ? A.token : '0', clientid: '', auth_xuid: '',
    user_type: A ? (A.ely ? 'mojang' : 'msa') : 'legacy', version_type: base.type, natives_directory: natives, launcher_name: 'Nexora', launcher_version: '0.2.0',
    classpath: cp, library_directory: path.join(ROOT, 'libraries'), classpath_separator: path.delimiter
  };
  const flat = a => a.flatMap(x => typeof x === 'string' ? [x] : allowed(x.rules) ? [].concat(x.value) : []);
  const fill = s => s.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  const num = n => { n = Math.round(+n); return n >= 200 && n <= 20000 ? n : 0; };
  const extra = fullscreen ? ['--fullscreen'] : num(ww) && num(wh) ? ['--width', String(num(ww)), '--height', String(num(wh))] : [];
  const agent = A?.ely ? [`-javaagent:${await ensureAuthlib()}=https://authserver.ely.by/api/authlib-injector`] : [];
  const args = [`-Xmx${ram}M`, ...agent, ...(jvm || '').split(/\s+/).filter(Boolean), ...flat(v.arguments.jvm).map(fill), v.mainClass, ...flat(v.arguments.game).map(fill), ...extra];

  return new Promise((resolve, reject) => {
    const p = spawn(java, args, { cwd: gameDir }); running.set(pid, p);
    p.on('error', er => reject(new Error(er.code === 'ENOENT' ? 'Java не найдена. Нужна Java {0}|' + need : er.message)));
    p.on('spawn', resolve);
    p.stdout.on('data', d => log(String(d).trimEnd())); p.stderr.on('data', d => log(String(d).trimEnd()));
    p.on('close', c => { running.delete(pid); sendRunning(); log('Игра закрыта, код {0}|' + c); });
  });
}

ipcMain.handle('versions', async () => {
  const ids = (await getJson(MANIFEST)).versions.filter(v => v.type === 'release').map(v => v.id);
  return ids.slice(0, ids.indexOf('1.19') + 1);
});
ipcMain.handle('launch', async (_, o) => {
  if (running.has(o.pid)) throw new Error('Эта сборка уже запущена');
  running.set(o.pid, null); sendRunning();
  try { await launch(o); } catch (e) { running.delete(o.pid); sendRunning(); throw e; }
});
ipcMain.handle('java:list', (_, force) => findJava(force));
ipcMain.handle('java:add', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [] });
  if (r.canceled) return null;
  const j = await probe(r.filePaths[0]);
  if (!j.version) throw new Error('Это не Java: {0}|' + j.error);
  const l = readCustom();
  if (!l.includes(r.filePaths[0])) { l.push(r.filePaths[0]); fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(CUSTOM, JSON.stringify(l)); }
  await findJava(true);
  return { path: j.path };
});
// Иконки загрузчиков берём из публичного API Modrinth (SVG, красятся в цвет темы), копию кэшируем
ipcMain.handle('icons', async () => {
  const f = path.join(ROOT, 'loader-icons.json');
  try {
    const r = await fetch('https://api.modrinth.com/v2/tag/loader', { headers: { 'User-Agent': 'NexoraLauncher/0.3.0' } });
    if (!r.ok) throw 0;
    const names = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' }, out = {};
    for (const l of await r.json()) if (names[l.name] && /^\s*<svg/i.test(l.icon))
      out[names[l.name]] = l.icon.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '');
    if (Object.keys(out).length) { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(f, JSON.stringify(out)); return out; }
  } catch {}
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
});
ipcMain.handle('locale', () => app.getLocale());
ipcMain.handle('cfg:get', () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return {}; } });
ipcMain.handle('cfg:set', (_, c) => { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); });

/* ---------- Microsoft / Minecraft аккаунт (device code flow) ---------- */
const ACCF = path.join(ROOT, 'account.json');
const MS = 'https://login.microsoftonline.com/consumers/oauth2/v2.0', CLIENT = '0148bc26-c363-4d68-9f67-930038d25f53', SCOPE = 'XboxLive.signin offline_access';
let acc = null, authCancelled = false;
async function post(url, body, json) {
  const r = await fetch(url, { method: 'POST', headers: json ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { 'Content-Type': 'application/x-www-form-urlencoded' }, body: json ? JSON.stringify(body) : new URLSearchParams(body) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = {}; }
  return { ok: r.ok, status: r.status, d };
}
async function mcLogin(msToken) {
  const x = await post('https://user.auth.xboxlive.com/user/authenticate', { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msToken }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' }, 1);
  if (!x.ok) throw new Error('Не удалось войти в Xbox Live');
  const uhs = x.d.DisplayClaims.xui[0].uhs;
  const s = await post('https://xsts.auth.xboxlive.com/xsts/authorize', { Properties: { SandboxId: 'RETAIL', UserTokens: [x.d.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' }, 1);
  if (!s.ok) {
    const E = { 2148916233: 'У аккаунта нет профиля Xbox. Создайте его на xbox.com', 2148916235: 'Xbox Live недоступен в вашей стране', 2148916238: 'Детскому аккаунту нужно разрешение родителей в семье Xbox' };
    throw new Error(E[s.d.XErr] || 'Ошибка XSTS: ' + (s.d.XErr || s.status));
  }
  const m = await post('https://api.minecraftservices.com/authentication/login_with_xbox', { identityToken: `XBL3.0 x=${uhs};${s.d.Token}` }, 1);
  if (!m.ok) throw new Error(/app registration/i.test(JSON.stringify(m.d)) ? 'Приложение ещё не одобрено Mojang (Invalid app registration)' : 'Minecraft Services: ' + m.status);
  const pr = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: 'Bearer ' + m.d.access_token } });
  if (pr.status === 404) throw new Error('На этом аккаунте нет Minecraft Java Edition');
  if (!pr.ok) throw new Error('Minecraft Services: ' + pr.status);
  const p = await pr.json();
  return { token: m.d.access_token, exp: Date.now() + (m.d.expires_in - 120) * 1000, uuid: p.id, name: p.name, skins: p.skins || [], capes: p.capes || [] };
}
const encR = t => safeStorage.isEncryptionAvailable() ? 'e:' + safeStorage.encryptString(t).toString('base64') : 'p:' + t;
const decR = t => t.startsWith('e:') ? safeStorage.decryptString(Buffer.from(t.slice(2), 'base64')) : t.slice(2);
function loadAcc() { try { const j = JSON.parse(fs.readFileSync(ACCF, 'utf8')); acc = { ...j, refresh: decR(j.refresh), token: null, exp: 0 }; } catch { acc = null; } }
function saveAcc() { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(ACCF, JSON.stringify({ name: acc.name, uuid: acc.uuid, skins: acc.skins, capes: acc.capes || [], refresh: encR(acc.refresh) })); }
const accView = () => {
  if (!acc) return null;
  const s = (acc.skins || []).find(x => x.state === 'ACTIVE') || (acc.skins || [])[0];
  return { type: 'ms', name: acc.name, uuid: acc.uuid, skin: s ? { url: s.url, variant: s.variant } : null, capes: (acc.capes || []).map(c => ({ id: c.id, alias: c.alias, url: c.url, active: c.state === 'ACTIVE' })) };
};
async function ensureToken() {
  if (!acc) return null;
  if (acc.token && acc.exp > Date.now()) return acc;
  const r = await post(MS + '/token', { client_id: CLIENT, grant_type: 'refresh_token', refresh_token: acc.refresh, scope: SCOPE });
  if (!r.ok) throw new Error('Сессия истекла, войдите заново');
  Object.assign(acc, await mcLogin(r.d.access_token), { refresh: r.d.refresh_token || acc.refresh }); saveAcc(); return acc;
}
async function authLogin() {
  authCancelled = false;
  const d = await post(MS + '/devicecode', { client_id: CLIENT, scope: SCOPE });
  if (!d.ok) throw new Error('Не удалось начать вход Microsoft');
  win.webContents.send('authcode', { code: d.d.user_code });
  if (String(d.d.verification_uri).startsWith('https://')) shell.openExternal(d.d.verification_uri);
  const end = Date.now() + d.d.expires_in * 1000; let wait = (d.d.interval || 5) * 1000;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, wait));
    if (authCancelled) throw new Error('Вход отменён');
    const t = await post(MS + '/token', { client_id: CLIENT, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.d.device_code });
    if (t.ok) { acc = { ...(await mcLogin(t.d.access_token)), refresh: t.d.refresh_token }; saveAcc(); setActive('ms'); return activeView(); }
    if (t.d.error === 'slow_down') wait += 5000;
    else if (t.d.error !== 'authorization_pending') throw new Error(t.d.error === 'authorization_declined' ? 'Вход отменён' : 'Не удалось войти: ' + (t.d.error || t.status));
  }
  throw new Error('Время ожидания входа истекло');
}
ipcMain.handle('auth:state', () => viewFresh());
ipcMain.handle('auth:login', authLogin);
ipcMain.handle('auth:cancel', () => { authCancelled = true; });

/* ---------- Ely.by (Yggdrasil + authlib-injector) и выбор активного аккаунта ---------- */
const ELYF = path.join(ROOT, 'ely.json'), ACTF = path.join(ROOT, 'active.json'), ELYA = 'https://authserver.ely.by/auth/';
let ely = null, activeType = null;
function loadEly() { try { const j = JSON.parse(fs.readFileSync(ELYF, 'utf8')); ely = { ...j, token: decR(j.token) }; } catch { ely = null; } }
function saveEly() { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(ELYF, JSON.stringify({ name: ely.name, uuid: ely.uuid, clientToken: ely.clientToken, token: encR(ely.token) })); }
function loadActive() { try { activeType = JSON.parse(fs.readFileSync(ACTF, 'utf8')).active; } catch { activeType = null; } }
function setActive(t) { activeType = t; fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(ACTF, JSON.stringify({ active: t })); }
function curType() {
  if (activeType === 'ely' && ely) return 'ely';
  if (activeType === 'ms' && acc) return 'ms';
  if (activeType === 'offline') return 'offline';
  return acc ? 'ms' : ely ? 'ely' : 'offline';
}
function activeView() {
  const t = curType();
  if (t === 'ms') return accView();
  if (t === 'ely') return { type: 'ely', name: ely.name, uuid: ely.uuid, skin: ely.skin || { url: `https://skinsystem.ely.by/skins/${encodeURIComponent(ely.name)}.png`, variant: 'CLASSIC' }, capes: [] };
  return null;
}
async function elyLogin(username, password, totp) {
  const clientToken = ely?.clientToken || crypto.randomUUID();
  const r = await post(ELYA + 'authenticate', { username, password: totp ? `${password}:${totp}` : password, clientToken, requestUser: true }, 1);
  if (!r.ok) {
    const m = String(r.d.errorMessage || '');
    if (/two.?factor/i.test(m)) throw new Error('Нужен код двухфакторной защиты Ely.by');
    if (/invalid credentials|username or password/i.test(m)) throw new Error('Неверный логин или пароль Ely.by');
    throw new Error('Ely.by: ' + (m || r.status));
  }
  const pr = r.d.selectedProfile || (r.d.availableProfiles || [])[0];
  if (!pr) throw new Error('На аккаунте Ely.by нет профиля');
  ely = { name: pr.name, uuid: pr.id, token: r.d.accessToken, clientToken: r.d.clientToken || clientToken }; saveEly(); setActive('ely');
  return viewFresh();
}
async function ensureEly() {
  if (!ely) return null;
  const v = await fetch(ELYA + 'validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: ely.token, clientToken: ely.clientToken }) });
  if (!v.ok) {
    const r = await post(ELYA + 'refresh', { accessToken: ely.token, clientToken: ely.clientToken }, 1);
    if (!r.ok) throw new Error('Сессия Ely.by истекла, войдите заново');
    ely.token = r.d.accessToken; if (r.d.clientToken) ely.clientToken = r.d.clientToken; saveEly();
  }
  return { name: ely.name, uuid: ely.uuid, token: ely.token, ely: true };
}
// Актуальный скин Ely.by (с типом рук) — из публичной системы скинов
async function elySkinRefresh() {
  if (!ely) return;
  try {
    const r = await fetch(`https://skinsystem.ely.by/textures/${encodeURIComponent(ely.name)}`);
    if (r.ok) { const j = await r.json(); if (j.SKIN?.url) ely.skin = { url: j.SKIN.url, variant: j.SKIN.metadata?.model === 'slim' ? 'SLIM' : 'CLASSIC' }; }
  } catch {}
}
async function viewFresh() { if (curType() === 'ely') await elySkinRefresh(); return activeView(); }
// Смена скина Ely.by: пробуем Mojang-совместимый API Ely.by, при отказе открываем сайт
async function elyApplySkin(variant) {
  if (!pickedSkin) throw new Error('Сначала выберите файл скина');
  const A = await ensureEly(), model = variant === 'slim' ? 'slim' : 'classic';
  let ok = false;
  try {
    const fd = new FormData(); fd.append('variant', model); fd.append('file', new Blob([pickedSkin], { type: 'image/png' }), 'skin.png');
    const r = await fetch('https://account.ely.by/api/mojang/services/minecraft/profile/skins', { method: 'POST', headers: { Authorization: 'Bearer ' + A.token }, body: fd });
    ok = r.ok;
  } catch {}
  addHist(pickedSkin, model, ok ? 'applied' : 'saved');
  if (!ok) { shell.openExternal('https://ely.by/skins'); throw new Error('Ely.by не принял скин напрямую: открыта страница Ely.by, загрузите файл там'); }
  return viewFresh();
}
ipcMain.handle('img:fetch', async (_, url) => {
  const u = new URL(String(url).replace(/^http:/, 'https:'));
  if (!['textures.minecraft.net', 'skinsystem.ely.by', 'ely.by'].includes(u.hostname)) throw new Error('bad host');
  const r = await fetch(u); if (!r.ok) throw new Error('Не удалось загрузить скин');
  return 'data:image/png;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
});
async function launchAuth() { const t = curType(); return t === 'ms' ? ensureToken() : t === 'ely' ? ensureEly() : null; }
async function ensureAuthlib() {
  const f = path.join(ROOT, 'authlib-injector.jar'); if (fs.existsSync(f)) return f;
  let meta; for (const u of ['https://authlib-injector.yushi.moe/artifact/latest.json', 'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json']) { try { meta = await getJson(u); break; } catch {} }
  if (!meta?.download_url || !String(meta.download_url).startsWith('https://')) throw new Error('Не удалось скачать authlib-injector');
  await download(meta.download_url, f); return f;
}
ipcMain.handle('auth:list', () => ({ active: curType(), ms: acc?.name || null, ely: ely?.name || null }));
ipcMain.handle('auth:select', (_, t) => { if (['ms', 'ely', 'offline'].includes(t)) setActive(t); return viewFresh(); });
ipcMain.handle('auth:logout', (_, t) => {
  if (t === 'ely') { ely = null; fs.rmSync(ELYF, { force: true }); } else if (t === 'ms') { acc = null; fs.rmSync(ACCF, { force: true }); }
  return activeView();
});
ipcMain.handle('ely:login', (_, o) => elyLogin(String(o.username || ''), String(o.password || ''), String(o.totp || '')));

/* ---------- Скины ---------- */
let pickedSkin = null;
const SKD = path.join(ROOT, 'skins'), SKI = path.join(SKD, 'index.json');
const readHist = () => { try { return JSON.parse(fs.readFileSync(SKI, 'utf8')); } catch { return []; } };
function addHist(buf, variant, label) {
  const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  fs.mkdirSync(SKD, { recursive: true }); fs.writeFileSync(path.join(SKD, id + '.png'), buf);
  const rest = readHist().filter(x => x.id !== id); rest.unshift({ id, variant, label, date: Date.now(), h: buf.readUInt32BE(20) });
  fs.writeFileSync(SKI, JSON.stringify(rest.slice(0, 60)));
}
ipcMain.handle('skin:hist', () => readHist().map(x => ({ ...x, url: pathToFileURL(path.join(SKD, x.id + '.png')).href })));
ipcMain.handle('skin:use', (_, id) => {
  const e = readHist().find(x => x.id === id); if (!e) throw new Error('Скин не найден');
  pickedSkin = fs.readFileSync(path.join(SKD, e.id + '.png')); return { url: 'data:image/png;base64,' + pickedSkin.toString('base64'), variant: e.variant };
});
ipcMain.handle('skin:histdel', (_, id) => { fs.rmSync(path.join(SKD, safe(id) + '.png'), { force: true }); fs.writeFileSync(SKI, JSON.stringify(readHist().filter(x => x.id !== id))); });
ipcMain.handle('cape:set', async (_, capeId) => {
  if (!acc) throw new Error('Войдите через Microsoft, чтобы сменить плащ');
  const A = await ensureToken(), H = { Authorization: 'Bearer ' + A.token };
  const r = await fetch('https://api.minecraftservices.com/minecraft/profile/capes/active', capeId ? { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ capeId }) } : { method: 'DELETE', headers: H });
  if (!r.ok) throw new Error('Не удалось сменить плащ (' + r.status + ')');
  const pr = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: H });
  if (pr.ok) { const p = await pr.json(); acc.skins = p.skins || acc.skins; acc.capes = p.capes || []; saveAcc(); }
  return accView();
});
ipcMain.handle('skin:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (r.canceled) return null;
  const b = fs.readFileSync(r.filePaths[0]);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(16) !== 64 || ![32, 64].includes(b.readUInt32BE(20))) throw new Error('Файл должен быть PNG 64×64 или 64×32');
  pickedSkin = b; return 'data:image/png;base64,' + b.toString('base64');
});
ipcMain.handle('skin:apply', async (_, variant) => {
  if (curType() === 'ely') return elyApplySkin(variant);
  if (!acc) throw new Error('Войдите через Microsoft, чтобы сменить скин');
  if (!pickedSkin) throw new Error('Сначала выберите файл скина');
  const A = await ensureToken(), fd = new FormData();
  try { // запоминаем текущий скин аккаунта, чтобы к нему можно было вернуться
    const cs = (acc.skins || []).find(x => x.state === 'ACTIVE');
    if (cs) { const r0 = await fetch(cs.url.replace('http://', 'https://')); if (r0.ok) addHist(Buffer.from(await r0.arrayBuffer()), String(cs.variant || 'CLASSIC').toLowerCase(), 'account'); }
  } catch {}
  fd.append('variant', variant === 'slim' ? 'slim' : 'classic'); fd.append('file', new Blob([pickedSkin], { type: 'image/png' }), 'skin.png');
  const r = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', { method: 'POST', headers: { Authorization: 'Bearer ' + A.token }, body: fd });
  if (!r.ok) throw new Error('Не удалось сменить скин (' + r.status + ')');
  const pj = await r.json(); acc.skins = pj.skins || []; acc.capes = pj.capes || acc.capes; saveAcc(); addHist(pickedSkin, variant === 'slim' ? 'slim' : 'classic', 'applied'); return accView();
});
ipcMain.handle('game:stop', (_, pid) => { running.get(pid)?.kill(); });

/* ---------- Modrinth: каталог и обновления ---------- */
const mr = async (p, opt = {}) => { const r = await fetch('https://api.modrinth.com/v2' + p, { ...opt, headers: { 'User-Agent': 'NexoraLauncher/0.3.0', 'Content-Type': 'application/json' } }); if (!r.ok) throw new Error('Modrinth: ' + r.status); return r.json(); };
const PT = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader', modpacks: 'modpack' };
const ldrs = l => ({ Fabric: ['fabric'], Quilt: ['quilt', 'fabric'], Forge: ['forge'], NeoForge: ['neoforge'] }[l] || []);
ipcMain.handle('mr:search', async (_, { kind, q, mc, loader, sort, cats, offset, compat }) => {
  if (!PT[kind]) throw new Error('bad kind');
  const f = [[`project_type:${PT[kind]}`]];
  if (compat) { f.push([`versions:${mc}`]); if (kind === 'mods') { const L = ldrs(loader); if (!L.length) throw new Error('Для модов выберите загрузчик, а не Vanilla'); f.push(L.map(x => `categories:${x}`)); } }
  for (const c of cats || []) f.push([`categories:${c}`]);
  const idx = ['relevance', 'downloads', 'newest', 'updated'].includes(sort) ? sort : 'downloads';
  const r = await mr(`/search?query=${encodeURIComponent(q || '')}&limit=20&offset=${+offset || 0}&index=${idx}&facets=${encodeURIComponent(JSON.stringify(f))}`);
  return { total: r.total_hits, hits: r.hits.map(h => ({ id: h.project_id, title: h.title, desc: h.description, icon: h.icon_url, author: h.author, dl: h.downloads })) };
});
ipcMain.handle('mr:categories', async (_, kind) => (await mr('/tag/category')).filter(c => c.project_type === PT[kind]).map(c => c.name));
ipcMain.handle('mr:project', async (_, { id, kind, mc, loader, compat }) => {
  const p = await mr('/project/' + encodeURIComponent(id));
  const q = compat ? `?game_versions=${encodeURIComponent(JSON.stringify([mc]))}` + (kind === 'mods' ? `&loaders=${encodeURIComponent(JSON.stringify(ldrs(loader)))}` : '') : '';
  const vs = await mr(`/project/${encodeURIComponent(id)}/version${q}`);
  return { id: p.id, slug: p.slug, type: p.project_type, title: p.title, desc: p.description, icon: p.icon_url, dl: p.downloads, follows: p.followers,
    versions: vs.slice(0, 40).map(v => ({ id: v.id, name: v.version_number, type: v.version_type, date: v.date_published, gv: (v.game_versions || []).slice(-3) })) };
});
ipcMain.handle('open:url', (_, u) => { if (/^https:\/\/modrinth\.com\//.test(u)) shell.openExternal(u); });
ipcMain.handle('shot:copy', (_, pid, name) => { clipboard.writeImage(nativeImage.createFromPath(path.join(kdir(pid, 'screenshots'), safe(name)))); });
async function mrInstall(pid, kind, projectId, mc, loader, seen = new Set(), depth = 0, versionId) {
  if (seen.has(projectId)) return []; seen.add(projectId);
  if (kind === 'mods' && !ldrs(loader).length) throw new Error('Для модов выберите загрузчик, а не Vanilla');
  const q = `?game_versions=${encodeURIComponent(JSON.stringify([mc]))}` + (kind === 'mods' ? `&loaders=${encodeURIComponent(JSON.stringify(ldrs(loader)))}` : '');
  const v = versionId ? await mr('/version/' + encodeURIComponent(versionId)) : (await mr(`/project/${encodeURIComponent(projectId)}/version${q}`))[0];
  if (!v) throw new Error('Нет подходящей версии для ' + mc);
  const f = v.files.find(x => x.primary) || v.files[0], d = kdir(pid, kind);
  fs.mkdirSync(d, { recursive: true }); await download(f.url, path.join(d, safe(f.filename)));
  const done = [f.filename];
  if (depth < 2) for (const dep of v.dependencies || []) if (dep.dependency_type === 'required' && dep.project_id) { try { done.push(...await mrInstall(pid, kind, dep.project_id, mc, loader, seen, depth + 1)); } catch {} }
  return done;
}
ipcMain.handle('mr:install', (_, o) => mrInstall(o.pid, o.kind, o.projectId, o.mc, o.loader, new Set(), 0, o.versionId));
// Предпросмотр установки: что именно скачается вместе с модом
ipcMain.handle('mr:plan', async (_, { pid, kind, projectId, versionId, mc, loader }) => {
  if (kind === 'mods' && !ldrs(loader).length) throw new Error('Для модов выберите загрузчик, а не Vanilla');
  const d = kdir(pid, kind), seen = new Set(), items = [], optional = [], missing = [], incompatible = [];
  const qs = `?game_versions=${encodeURIComponent(JSON.stringify([mc]))}` + (kind === 'mods' ? `&loaders=${encodeURIComponent(JSON.stringify(ldrs(loader)))}` : '');
  async function walk(id, vid, depth) {
    if (seen.has(id)) return; seen.add(id);
    const v = vid ? await mr('/version/' + encodeURIComponent(vid)) : (await mr(`/project/${encodeURIComponent(id)}/version${qs}`))[0];
    if (!v) { if (depth) missing.push({ projectId: id }); else throw new Error('Нет подходящей версии для ' + mc); return; }
    const f = v.files.find(x => x.primary) || v.files[0];
    items.push({ projectId: id, filename: f.filename, size: f.size, have: fs.existsSync(path.join(d, f.filename)) });
    if (depth < 2) for (const dep of v.dependencies || []) {
      if (!dep.project_id) continue;
      if (dep.dependency_type === 'required') await walk(dep.project_id, undefined, depth + 1);
      else if (dep.dependency_type === 'optional') optional.push({ projectId: dep.project_id });
      else if (dep.dependency_type === 'incompatible') incompatible.push({ projectId: dep.project_id });
    }
  }
  await walk(projectId, versionId, 0);
  const ids = [...new Set([...items, ...optional, ...missing, ...incompatible].map(x => x.projectId))], P = {};
  for (const x of await mr('/projects?ids=' + encodeURIComponent(JSON.stringify(ids)))) P[x.id] = x;
  const dec = x => ({ ...x, title: P[x.projectId]?.title || x.projectId, icon: P[x.projectId]?.icon_url });
  return { items: items.map(dec), optional: optional.map(dec), missing: missing.map(dec), incompatible: incompatible.map(dec) };
});
// Своя картинка для сборки: обрезаем до квадрата 128×128
ipcMain.handle('icon:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }] });
  if (r.canceled) return null;
  let img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new Error('Не удалось открыть картинку');
  const { width: w, height: h } = img.getSize(), sq = Math.min(w, h);
  img = img.crop({ x: Math.floor((w - sq) / 2), y: Math.floor((h - sq) / 2), width: sq, height: sq }).resize({ width: 128, height: 128, quality: 'best' });
  return 'data:image/png;base64,' + img.toPNG().toString('base64');
});
async function loaderVer(L, mc, lver) {
  if (lver) return lver; L = L.toLowerCase();
  if (L === 'fabric' || L === 'quilt') { const lv = await getJson(`${L === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3'}/versions/loader/${mc}`); return (lv.find(x => x.loader.stable !== false) || lv[0])?.loader.version; }
  if (L === 'forge') { const pr = (await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos; return pr[mc + '-recommended'] || pr[mc + '-latest']; }
  const [, a, b] = mc.split('.'); return (await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions.filter(v => v.startsWith(`${a}.${b || 0}.`) && !v.includes('-')).pop();
}
// Экспорт в .mrpack: файлы с Modrinth — ссылками, остальное — в overrides
ipcMain.handle('mrpack:export', async (_, pid, meta, worlds) => {
  const base = inst(pid);
  const r = await dialog.showSaveDialog(win, { defaultPath: String(meta.n || 'pack').replace(/[^\w.-]+/g, '_') + '.mrpack', filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }] });
  if (r.canceled) return null;
  const lst = (k, re) => { try { return fs.readdirSync(path.join(base, k), { withFileTypes: true }).filter(e => e.isFile() && re.test(e.name)).map(e => k + '/' + e.name); } catch { return []; } };
  const hs = [...lst('mods', /\.jar$/i), ...lst('resourcepacks', /\.zip$/i), ...lst('shaderpacks', /\.zip$/i)].map(rel => ({ rel, h: sha1(path.join(base, rel)) }));
  const known = hs.length ? await mr('/version_files', { method: 'POST', body: JSON.stringify({ hashes: hs.map(x => x.h), algorithm: 'sha1' }) }) : {};
  const files = [], over = [];
  for (const x of hs) {
    const f = known[x.h]?.files.find(y => y.hashes?.sha1 === x.h);
    if (f && f.hashes.sha512 && String(f.url).startsWith('https://cdn.modrinth.com/')) files.push({ path: x.rel, hashes: { sha1: x.h, sha512: f.hashes.sha512 }, env: { client: 'required', server: 'required' }, downloads: [f.url], fileSize: f.size });
    else over.push(x.rel);
  }
  const bundled = over.length;
  for (const d of ['config', 'defaultconfigs', 'kubejs', 'scripts', ...(worlds ? ['saves'] : [])]) walk(base, d, over);
  for (const f of ['options.txt', 'servers.dat']) if (fs.existsSync(path.join(base, f))) over.push(f);
  const dep = { minecraft: meta.v };
  if (meta.l !== 'Vanilla') { const lv = await loaderVer(meta.l, meta.v, meta.lv); if (lv) dep[{ Fabric: 'fabric-loader', Quilt: 'quilt-loader', Forge: 'forge', NeoForge: 'neoforge' }[meta.l]] = lv; }
  const index = { formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: meta.n, summary: 'Exported from Nexora Launcher', files, dependencies: dep };
  fs.writeFileSync(r.filePath, zipWrite([{ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2)) }, ...over.map(rel => ({ name: 'overrides/' + rel, data: fs.readFileSync(path.join(base, rel)) }))]));
  return { files: files.length, bundled };
});
async function iconData(url) {
  try {
    if (!String(url).startsWith('https://cdn.modrinth.com/')) return undefined;
    const r = await fetch(url); if (!r.ok) return undefined;
    let img = nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer())); if (img.isEmpty()) return undefined;
    const { width: w, height: h } = img.getSize(), sq = Math.min(w, h);
    img = img.crop({ x: Math.floor((w - sq) / 2), y: Math.floor((h - sq) / 2), width: sq, height: sq }).resize({ width: 128, height: 128, quality: 'best' });
    return 'data:image/png;base64,' + img.toPNG().toString('base64');
  } catch { return undefined; }
}
// Установка модпака из каталога Modrinth как новой сборки
ipcMain.handle('mr:modpack', async (_, { projectId, versionId, pid }) => {
  const p = await mr('/project/' + encodeURIComponent(projectId));
  const v = versionId ? await mr('/version/' + encodeURIComponent(versionId)) : (await mr(`/project/${encodeURIComponent(projectId)}/version`))[0];
  if (!v) throw new Error('Нет подходящих версий');
  const f = v.files.find(x => x.primary) || v.files[0];
  if (!f || !/\.mrpack$/i.test(f.filename) || !String(f.url).startsWith('https://cdn.modrinth.com/')) throw new Error('В этой версии нет файла .mrpack');
  const r = await fetch(f.url); if (!r.ok) throw new Error('Modrinth: ' + r.status);
  const m = await importMrpack(zipRead(Buffer.from(await r.arrayBuffer())), pid, o => win.webContents.send('impprog', o));
  m.n = m.n || p.title; m.img = await iconData(p.icon_url);
  return m;
});
const hashMemo = new Map(), idCache = new Map();
const sha1 = f => { const st = fs.statSync(f), k = f + st.size + st.mtimeMs; if (!hashMemo.has(k)) hashMemo.set(k, crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')); return hashMemo.get(k); };
// Опознаёт файлы по хешу: название, иконка, проект и доступное обновление
ipcMain.handle('mr:identify', async (_, pid, kind, mc, loader) => {
  const d = kdir(pid, kind), re = kind === 'mods' ? /\.jar(\.disabled)?$/i : /\.zip$/i; let names = [];
  try { names = fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isFile() && re.test(e.name)).map(e => e.name); } catch { return []; }
  if (!names.length) return [];
  const hs = names.map(n => ({ n, h: sha1(path.join(d, n)) })), sig = [pid, kind, mc, loader, ...hs.map(x => x.h + x.n)].join('|');
  const c = idCache.get(sig); if (c && c.t > Date.now() - 6e5) return c.v;
  const hashes = hs.map(x => x.h);
  const cur = await mr('/version_files', { method: 'POST', body: JSON.stringify({ hashes, algorithm: 'sha1' }) });
  const ids = [...new Set(Object.values(cur).map(v => v.project_id))], P = {};
  if (ids.length) for (const x of await mr('/projects?ids=' + encodeURIComponent(JSON.stringify(ids)))) P[x.id] = x;
  const upd = kind === 'mods' ? await mr('/version_files/update', { method: 'POST', body: JSON.stringify({ hashes, algorithm: 'sha1', loaders: ldrs(loader), game_versions: [mc] }) }).catch(() => ({})) : {};
  const out = hs.filter(x => cur[x.h]).map(x => {
    const pr = P[cur[x.h].project_id], u = upd[x.h], f = u && (u.files.find(y => y.primary) || u.files[0]);
    return { name: x.n, project: cur[x.h].project_id, title: pr?.title, icon: pr?.icon_url, update: f && f.hashes.sha1 !== x.h ? { newName: f.filename + (/\.disabled$/i.test(x.n) ? '.disabled' : ''), url: f.url } : null };
  });
  idCache.set(sig, { t: Date.now(), v: out }); return out;
});
ipcMain.handle('mr:apply', async (_, pid, items) => {
  const d = kdir(pid, 'mods');
  for (const it of items) {
    if (!String(it.url).startsWith('https://cdn.modrinth.com/')) continue;
    await download(it.url, path.join(d, safe(it.newName)));
    if (it.newName !== it.name) fs.rmSync(path.join(d, safe(it.name)), { force: true });
  }
  return items.length;
});
ipcMain.handle('loader:versions', async (_, L, mc) => {
  L = L.toLowerCase();
  if (L === 'fabric' || L === 'quilt') return (await getJson(`${L === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3'}/versions/loader/${mc}`)).map(x => x.loader.version);
  if (L === 'forge') { const x = await (await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml')).text(); return [...x.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]).filter(v => v.startsWith(mc + '-')).map(v => v.slice(mc.length + 1)).reverse(); }
  const [, a, b] = mc.split('.'); return (await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions.filter(v => v.startsWith(`${a}.${b || 0}.`)).reverse();
});

/* ---------- Экспорт / импорт / копирование сборок (zip) ---------- */
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipWrite(entries) {
  const parts = [], cen = []; let off = 0;
  for (const { name, data } of entries) {
    const nb = Buffer.from(name, 'utf8'), cd = zlib.deflateRawSync(data), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(cd.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
    parts.push(h, nb, cd);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(cd.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    cen.push(c, nb); off += 30 + nb.length + cd.length;
  }
  const cb = Buffer.concat(cen), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cb, e]);
}
function zipRead(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Это не архив сборки Nexora');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  for (let i = 0; i < n; i++) {
    const m = buf.readUInt16LE(p + 10), cs = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    out.push({ name, get: () => { const raw = buf.subarray(ds, ds + cs); return m === 8 ? zlib.inflateRawSync(raw) : raw; } });
  }
  return out;
}
function walk(base, rel, out) {
  let es = []; try { es = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch { return; }
  for (const e of es) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(base, r, out); else out.push(r); }
}
ipcMain.handle('profile:export', async (_, pid, meta, worlds) => {
  const base = inst(pid), files = [];
  for (const d of ['mods', 'config', 'resourcepacks', 'shaderpacks', ...(worlds ? ['saves'] : [])]) walk(base, d, files);
  for (const f of ['options.txt', 'servers.dat']) if (fs.existsSync(path.join(base, f))) files.push(f);
  const r = await dialog.showSaveDialog(win, { defaultPath: String(meta.n || 'profile').replace(/[^\w.-]+/g, '_') + '.nexora.zip', filters: [{ name: 'ZIP', extensions: ['zip'] }] });
  if (r.canceled) return false;
  fs.writeFileSync(r.filePath, zipWrite([{ name: 'nexora-profile.json', data: Buffer.from(JSON.stringify(meta)) }, ...files.map(f => ({ name: 'files/' + f, data: fs.readFileSync(path.join(base, f)) }))]));
  return true;
});
const MRHOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
// Импорт модпака Modrinth (.mrpack): скачивает файлы с проверкой sha1 и распаковывает overrides
async function importMrpack(es, pid, send) {
  const idx = JSON.parse(es.find(e => e.name === 'modrinth.index.json').get().toString('utf8'));
  const base = path.resolve(inst(pid)); fs.mkdirSync(base, { recursive: true });
  const within = rel => { const t = path.resolve(base, String(rel)); return t.startsWith(base + path.sep) ? t : null; };
  const files = (idx.files || []).filter(f => f.env?.client !== 'unsupported'), failed = []; let done = 0;
  send({ done: 0, total: files.length });
  await pool(files, 8, async f => {
    try {
      const t = within(f.path); if (!t) throw 0;
      if (!fs.existsSync(t)) {
        let ok = false;
        for (const u of f.downloads || []) {
          let url; try { url = new URL(u); } catch { continue; }
          if (url.protocol !== 'https:' || !MRHOSTS.includes(url.hostname)) continue;
          const r = await fetch(url); if (!r.ok) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          if (f.hashes?.sha1 && crypto.createHash('sha1').update(buf).digest('hex') !== f.hashes.sha1) continue;
          fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, buf); ok = true; break;
        }
        if (!ok) throw 0;
      }
    } catch { failed.push(path.basename(String(f.path))); }
    send({ done: ++done, total: files.length });
  });
  for (const e of es) for (const pre of ['overrides/', 'client-overrides/'])
    if (e.name.startsWith(pre) && !e.name.endsWith('/')) { const t = within(e.name.slice(pre.length)); if (t) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, e.get()); } }
  const d = idx.dependencies || {};
  const L = d['fabric-loader'] ? ['Fabric', d['fabric-loader']] : d['quilt-loader'] ? ['Quilt', d['quilt-loader']] : d.neoforge ? ['NeoForge', d.neoforge] : d.forge ? ['Forge', d.forge] : ['Vanilla', ''];
  return { n: idx.name, v: d.minecraft, l: L[0], lv: L[1], failed };
}
ipcMain.handle('profile:import', async (_, pid) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Nexora / Modrinth', extensions: ['zip', 'mrpack'] }] });
  if (r.canceled) return null;
  const es = zipRead(fs.readFileSync(r.filePaths[0])), m = es.find(e => e.name === 'nexora-profile.json');
  if (es.some(e => e.name === 'modrinth.index.json')) return importMrpack(es, pid, o => win.webContents.send('impprog', o));
  if (!m) throw new Error('Это не архив сборки Nexora');
  const base = path.resolve(inst(pid));
  for (const e of es) {
    if (!e.name.startsWith('files/') || e.name.endsWith('/')) continue;
    const t = path.resolve(base, e.name.slice(6)); if (!t.startsWith(base + path.sep)) continue;
    fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, e.get());
  }
  return JSON.parse(m.get().toString('utf8'));
});
ipcMain.handle('profile:copy', (_, src, dst) => { if (running.has(src)) throw new Error('Сначала закройте игру'); if (fs.existsSync(inst(src))) fs.cpSync(inst(src), inst(dst), { recursive: true }); });
const EXT = { mods: /\.jar$/i, resourcepacks: /\.zip$/i, shaderpacks: /\.zip$/i };
ipcMain.handle('inst:copy', (_, pid, k, files) => {
  const re = EXT[k]; if (!re) return 0; const d = kdir(pid, k); fs.mkdirSync(d, { recursive: true }); let n = 0;
  for (const f of files) if (re.test(f) && fs.statSync(f).isFile()) { fs.copyFileSync(f, path.join(d, path.basename(f))); n++; }
  return n;
});

/* ---------- Файлы сборки ---------- */
const inst = pid => { if (!/^[\w.-]+$/.test(pid) || /^\.+$/.test(pid)) throw new Error('bad id'); return path.join(ROOT, 'instances', pid); };
const KIND = { mods: 'mods', resourcepacks: 'resourcepacks', shaderpacks: 'shaderpacks', worlds: 'saves', screenshots: 'screenshots' };
const kdir = (pid, k) => { if (!KIND[k]) throw new Error('bad kind'); return path.join(inst(pid), KIND[k]); };
const safe = n => { if (n !== path.basename(n) || /^\.+$/.test(n)) throw new Error('bad name'); return n; };
ipcMain.handle('inst:list', (_, pid, k) => {
  const d = kdir(pid, k); let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of es) {
    const f = path.join(d, e.name), n = e.name, dir = e.isDirectory(); let st; try { st = fs.statSync(f); } catch { continue; }
    if (k === 'mods' && !/\.jar(\.disabled)?$/i.test(n)) continue;
    if (k === 'worlds' && !dir) continue;
    if ((k === 'resourcepacks' || k === 'shaderpacks') && !dir && !/\.zip$/i.test(n)) continue;
    if (k === 'screenshots' && !/\.(png|jpe?g)$/i.test(n)) continue;
    out.push({ name: n, label: n.replace(/\.disabled$/i, ''), disabled: /\.disabled$/i.test(n), size: dir ? null : st.size, mtime: st.mtimeMs, url: k === 'screenshots' ? pathToFileURL(f).href : undefined, icon: k === 'worlds' && fs.existsSync(path.join(f, 'icon.png')) ? pathToFileURL(path.join(f, 'icon.png')).href : undefined });
  }
  return out.sort((a, b) => k === 'screenshots' ? b.mtime - a.mtime : a.label.localeCompare(b.label));
});
ipcMain.handle('inst:add', async (_, pid, k) => {
  const ext = { mods: ['jar'], resourcepacks: ['zip'], shaderpacks: ['zip'] }[k]; if (!ext) return 0;
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: k, extensions: ext }] });
  if (r.canceled) return 0;
  const d = kdir(pid, k); fs.mkdirSync(d, { recursive: true });
  r.filePaths.forEach(f => fs.copyFileSync(f, path.join(d, path.basename(f)))); return r.filePaths.length;
});
ipcMain.handle('inst:rm', (_, pid, k, n) => fs.rmSync(path.join(kdir(pid, k), safe(n)), { recursive: true, force: true }));
ipcMain.handle('inst:toggle', (_, pid, n) => { const f = path.join(kdir(pid, 'mods'), safe(n)); fs.renameSync(f, /\.disabled$/i.test(n) ? f.replace(/\.disabled$/i, '') : f + '.disabled'); });
ipcMain.handle('inst:open', (_, pid, k, n) => { const d = k ? kdir(pid, k) : inst(pid); fs.mkdirSync(d, { recursive: true }); return shell.openPath(n ? path.join(d, safe(n)) : d); });
ipcMain.handle('inst:delete', (_, pid, files) => {
  if (running.has(pid)) throw new Error('Сначала закройте игру');
  if (files) fs.rmSync(inst(pid), { recursive: true, force: true });
});

ipcMain.handle('inst:counts', (_, pid) => {
  const cnt = (k, f) => { try { return fs.readdirSync(kdir(pid, k), { withFileTypes: true }).filter(f).length; } catch { return 0; } };
  const file = re => e => e.isFile() && re.test(e.name);
  let servers = 0; try { servers = srvView(srvLoad(pid)).length; } catch {}
  return { mods: cnt('mods', file(/\.jar(\.disabled)?$/i)), resourcepacks: cnt('resourcepacks', e => e.isDirectory() || /\.zip$/i.test(e.name)),
    shaderpacks: cnt('shaderpacks', e => e.isDirectory() || /\.zip$/i.test(e.name)), worlds: cnt('worlds', e => e.isDirectory()), servers, screenshots: cnt('screenshots', file(/\.(png|jpe?g)$/i)) };
});

/* ---------- servers.dat (несжатый NBT) ---------- */
function nbtRead(buf) {
  let o = 0;
  const rd = {
    1: () => buf.readInt8(o++), 2: () => { const v = buf.readInt16BE(o); o += 2; return v; }, 3: () => { const v = buf.readInt32BE(o); o += 4; return v; },
    4: () => { const v = buf.readBigInt64BE(o); o += 8; return v; }, 5: () => { const v = buf.readFloatBE(o); o += 4; return v; }, 6: () => { const v = buf.readDoubleBE(o); o += 8; return v; },
    7: () => { const n = rd[3](), v = buf.subarray(o, o + n); o += n; return v; },
    8: () => { const n = buf.readUInt16BE(o); o += 2; const v = buf.toString('utf8', o, o + n); o += n; return v; },
    9: () => { const t = buf.readInt8(o++), n = rd[3](), a = []; for (let i = 0; i < n; i++) a.push(rd[t]()); return { t, a }; },
    10: () => { const c = {}; for (;;) { const t = buf.readInt8(o++); if (!t) break; const k = rd[8](); c[k] = { t, v: rd[t]() }; } return c; },
    11: () => { const n = rd[3](), a = []; for (let i = 0; i < n; i++) a.push(rd[3]()); return a; },
    12: () => { const n = rd[3](), a = []; for (let i = 0; i < n; i++) a.push(rd[4]()); return a; }
  };
  rd[1](); rd[8](); return rd[10]();
}
function nbtWrite(root) {
  const out = [], num = (n, m, v) => { const b = Buffer.alloc(n); b[m](v); out.push(b); };
  const wr = {
    1: v => num(1, 'writeInt8', v), 2: v => num(2, 'writeInt16BE', v), 3: v => num(4, 'writeInt32BE', v), 4: v => num(8, 'writeBigInt64BE', BigInt(v)),
    5: v => num(4, 'writeFloatBE', v), 6: v => num(8, 'writeDoubleBE', v), 7: v => { wr[3](v.length); out.push(v); },
    8: v => { const b = Buffer.from(v, 'utf8'); num(2, 'writeUInt16BE', b.length); out.push(b); },
    9: v => { wr[1](v.t); wr[3](v.a.length); v.a.forEach(x => wr[v.t](x)); },
    10: c => { for (const [k, { t, v }] of Object.entries(c)) { wr[1](t); wr[8](k); wr[t](v); } wr[1](0); },
    11: v => { wr[3](v.length); v.forEach(x => wr[3](x)); }, 12: v => { wr[3](v.length); v.forEach(x => wr[4](x)); }
  };
  wr[1](10); wr[8](''); wr[10](root); return Buffer.concat(out);
}
const srvFile = pid => path.join(inst(pid), 'servers.dat');
function srvLoad(pid) {
  let r; try { r = nbtRead(fs.readFileSync(srvFile(pid))); } catch { r = {}; }
  r.servers ??= { t: 9, v: { t: 10, a: [] } }; return r;
}
const srvView = r => r.servers.v.a.map(x => ({ name: x.name?.v || '', ip: x.ip?.v || '', icon: x.icon?.v ? 'data:image/png;base64,' + x.icon.v : undefined }));
function srvSave(pid, r) { fs.mkdirSync(inst(pid), { recursive: true }); fs.writeFileSync(srvFile(pid), nbtWrite(r)); return srvView(r); }
ipcMain.handle('srv:list', (_, pid) => srvView(srvLoad(pid)));
ipcMain.handle('srv:add', (_, pid, name, ip) => { const r = srvLoad(pid); r.servers.v.t = 10; r.servers.v.a.push({ name: { t: 8, v: name }, ip: { t: 8, v: ip } }); return srvSave(pid, r); });
ipcMain.handle('srv:rm', (_, pid, i) => { const r = srvLoad(pid); r.servers.v.a.splice(i, 1); return srvSave(pid, r); });

/* ---------- Discord Rich Presence (IPC без внешних библиотек) ---------- */
// Application ID из https://discord.com/developers/applications (New Application). Пока пусто — Rich Presence выключен.
const DISCORD_CLIENT_ID = process.env.NEXORA_DISCORD_ID || '1573652512462872728';
const net = require('net');
const rpc = { sock: null, ready: false, connecting: false, last: null, want: null, retry: null };
function rpcPaths() {
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const dirs = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp'].filter(Boolean), out = [];
  for (const d of dirs) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`), path.join(d, 'app/com.discordapp.Discord', `discord-ipc-${i}`), path.join(d, 'snap.discord', `discord-ipc-${i}`));
  return out;
}
const rpcPack = (op, obj) => { const b = Buffer.from(JSON.stringify(obj)), h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(b.length, 4); return Buffer.concat([h, b]); };
const rpcLater = () => { if (rpc.want && !rpc.retry) rpc.retry = setTimeout(() => { rpc.retry = null; rpcConnect(); }, 15000); };
function rpcConnect() {
  if (!DISCORD_CLIENT_ID || rpc.sock || rpc.connecting) return;
  rpc.connecting = true;
  const next = list => {
    const p = list.shift();
    if (!p) { rpc.connecting = false; rpcLater(); return; } // Discord не запущен — попробуем позже
    const s = net.createConnection(p); let buf = Buffer.alloc(0), opened = false;
    s.once('connect', () => { opened = true; s.write(rpcPack(0, { v: 1, client_id: DISCORD_CLIENT_ID })); });
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const len = buf.readInt32LE(4); if (buf.length < 8 + len) break;
        let msg = {}; try { msg = JSON.parse(buf.subarray(8, 8 + len).toString()); } catch {}
        buf = buf.subarray(8 + len);
        if (msg.evt === 'READY') { rpc.sock = s; rpc.ready = true; rpc.connecting = false; rpc.last = null; rpcApply(); }
      }
    });
    s.on('error', () => { if (!opened) next(list); });
    s.on('close', () => { if (rpc.sock === s) { rpc.sock = null; rpc.ready = false; rpc.last = null; rpcLater(); } else if (opened && !rpc.ready) { rpc.connecting = false; rpcLater(); } });
  };
  next(rpcPaths());
}
function rpcApply() {
  if (!rpc.ready) return;
  const a = rpc.want, key = JSON.stringify(a); if (key === rpc.last) return; rpc.last = key;
  rpc.sock.write(rpcPack(1, { cmd: 'SET_ACTIVITY', nonce: String(Date.now() + Math.random()), args: { pid: process.pid, activity: a ? {
    details: a.details || undefined, state: a.state || undefined, timestamps: a.start ? { start: a.start } : undefined,
    assets: { large_image: 'nexora', large_text: 'Nexora Launcher' } } : null } }));
}
ipcMain.handle('rpc:info', () => ({ available: !!DISCORD_CLIENT_ID }));
ipcMain.handle('rpc:set', (_, a) => {
  rpc.want = a ? { details: String(a.details || '').slice(0, 128), state: String(a.state || '').slice(0, 128), start: a.start ? Math.floor(a.start / 1000) : undefined } : null;
  if (rpc.want) rpcConnect();
  rpcApply();
});
app.on('before-quit', () => rpc.sock?.destroy());

/* ---------- Ярлык сборки и автозапуск ---------- */
let pendingPid = (process.argv.find(a => a.startsWith('--launch=')) || '').slice(9) || null;
const gotLock = app.requestSingleInstanceLock();
app.on('second-instance', (_, argv) => {
  const a = argv.find(x => x.startsWith('--launch='));
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (a) win.webContents.send('autolaunch', a.slice(9)); }
});
ipcMain.handle('launch:pending', () => { const p = pendingPid; pendingPid = null; return p; });
const pngToIco = (png, size) => { const h = Buffer.alloc(22); h.writeUInt16LE(1, 2); h.writeUInt16LE(1, 4); h[6] = size % 256; h[7] = size % 256; h.writeUInt16LE(1, 10); h.writeUInt16LE(32, 12); h.writeUInt32LE(png.length, 14); h.writeUInt32LE(22, 18); return Buffer.concat([h, png]); };
ipcMain.handle('shortcut:create', (_, pid, name, img) => {
  inst(pid);
  const desk = app.getPath('desktop'), title = String(name || 'Minecraft').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) + ' — Nexora';
  const args = (app.isPackaged ? '' : `"${app.getAppPath()}" `) + `--launch=${pid}`;
  let icon;
  if (/^data:image\/png;base64,/.test(img || '')) {
    fs.mkdirSync(path.join(ROOT, 'icons'), { recursive: true }); const png = Buffer.from(img.split(',')[1], 'base64');
    icon = path.join(ROOT, 'icons', pid + (process.platform === 'win32' ? '.ico' : '.png'));
    fs.writeFileSync(icon, process.platform === 'win32' ? pngToIco(png, 128) : png);
  }
  if (process.platform === 'win32') shell.writeShortcutLink(path.join(desk, title + '.lnk'), 'create', { target: process.execPath, args, cwd: path.dirname(process.execPath), description: 'Nexora Launcher: ' + name, ...(icon ? { icon, iconIndex: 0 } : {}) });
  else if (process.platform === 'linux') fs.writeFileSync(path.join(desk, title + '.desktop'), `[Desktop Entry]\nType=Application\nName=${title}\nExec="${process.execPath}" ${args}\n${icon ? 'Icon=' + icon + '\n' : ''}Terminal=false\n`, { mode: 0o755 });
  else fs.writeFileSync(path.join(desk, title + '.command'), `#!/bin/bash\n"${process.execPath}" ${args} &\n`, { mode: 0o755 });
  return true;
});

/* ---------- Автообновление через GitHub Releases ---------- */
let autoUpdater = null; try { autoUpdater = require('electron-updater').autoUpdater; } catch {}
const updSend = o => win?.webContents.send('upd', o);
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', i => updSend({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => updSend({ state: 'none' }));
  autoUpdater.on('download-progress', p => updSend({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => updSend({ state: 'downloaded', version: i.version }));
  autoUpdater.on('error', e => updSend({ state: 'error', message: String(e?.message || e).slice(0, 160) }));
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
}
ipcMain.handle('app:version', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.handle('upd:check', async () => {
  if (!autoUpdater || !app.isPackaged) return { state: 'dev' };
  try { await autoUpdater.checkForUpdates(); return { state: 'checking' }; } catch (e) { return { state: 'error', message: String(e.message).slice(0, 160) }; }
});
ipcMain.handle('upd:download', () => { autoUpdater?.downloadUpdate().catch(e => updSend({ state: 'error', message: String(e.message).slice(0, 160) })); });
ipcMain.handle('upd:install', () => autoUpdater?.quitAndInstall());

app.whenReady().then(() => {
  if (!gotLock) { app.quit(); return; }
  loadAcc(); loadEly(); loadActive();
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 720, minHeight: 560, title: 'Nexora Launcher', autoHideMenuBar: true,
    show: false, icon: path.join(__dirname, 'build', 'icon.png'), backgroundColor: nativeTheme.shouldUseDarkColors ? '#141218' : '#FEF7FF',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile('renderer/index.html');
  win.once('ready-to-show', () => win.show());
  setupUpdater();
});
app.on('window-all-closed', () => app.quit());
