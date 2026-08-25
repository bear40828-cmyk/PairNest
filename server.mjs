// PairNest —— 两个人的小屋。所有私人内容都在 config.json 和 data/ 里，代码本身不带任何个人信息。
import { createServer } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, readdir, mkdir, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, extname, resolve, sep, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, 'data')
const UPLOADS = join(DATA, 'uploads')
const CONFIG_FILE = join(HERE, 'config.json')

// 首次启动自动生成本机配置和随机凭据。config.json 已被 gitignore，不会被提交。
let CFG
let firstRun = false
try {
  CFG = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
} catch (e) {
  if (e.code !== 'ENOENT') throw new Error(`config.json 解析失败：${e.message}`)
  CFG = JSON.parse(await readFile(join(HERE, 'config.example.json'), 'utf8'))
  firstRun = true
}
CFG.auth = CFG.auth || {}
let generatedCredentials = false
if (!CFG.auth.password) {
  CFG.auth.password = randomBytes(15).toString('base64url')
  generatedCredentials = true
}
if (!CFG.auth.secret) {
  CFG.auth.secret = randomBytes(32).toString('base64url')
  generatedCredentials = true
}
if (!CFG.auth.apiToken) {
  CFG.auth.apiToken = randomBytes(32).toString('base64url')
  generatedCredentials = true
}
if (firstRun || generatedCredentials) {
  await writeFile(CONFIG_FILE, JSON.stringify(CFG, null, 2) + '\n', { mode: 0o600 })
  try { await chmod(CONFIG_FILE, 0o600) } catch {}
  console.log('\nPairNest 已生成本机 config.json（不会提交到 Git）。')
  console.log(`网页登录密码：${CFG.auth.password}`)
  console.log(`API Token：${CFG.auth.apiToken}`)
  console.log('请现在保存这两个值；以后可在 config.json 的 auth 中修改。\n')
}

// 刚 clone 下来没有 data 目录；同时把用户上传的纪念日背景限制在 data/uploads。
await mkdir(join(DATA, 'memories'), { recursive: true })
await mkdir(UPLOADS, { recursive: true })

const PORT_CFG = CFG.port || 8795
const HOST_CFG = CFG.host || '127.0.0.1'
const FEATURES = Object.assign(
  { location: false, keyring: false, memories: false, handoff: false },
  CFG.features || {},
)

// 高德地图：不填就退回免费的 Nominatim 反查，只是没有地图底图
const AMAP = CFG.amap || null

// 在一起的第一天，写在 config.json 里
const START = CFG.startDate || '2026-01-01'
const BJ = 8 * 3600 * 1000
const AUTH_PASSWORD = String(process.env.PAIRNEST_PASSWORD || CFG.auth.password)
const AUTH_SECRET = String(process.env.PAIRNEST_AUTH_SECRET || CFG.auth.secret)
const API_TOKEN = String(process.env.PAIRNEST_API_TOKEN || CFG.auth.apiToken)
const SESSION_SECONDS = 30 * 24 * 60 * 60
const AUTH_COOKIE = 'pn_session'

const DEFAULT_ANNIV = CFG.anniversaries || [
  { name: '在一起', date: CFG.startDate || '2026-01-01', kind: 'since' },
]

// 两点相距多少米
function metersBetween(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180
  const dφ = (c - a) * r, dλ = (d - b) * r
  const x = Math.sin(dφ / 2) ** 2 +
            Math.cos(a * r) * Math.cos(c * r) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

const bjToday = () => new Date(Date.now() + BJ).toISOString().slice(0, 10)
const daysBetween = (a, b) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)

// ---- 小文件存储：每类一个 json，够用且能直接看 ----
async function load(name, fallback) {
  try { return JSON.parse(await readFile(join(DATA, name + '.json'), 'utf8')) }
  catch { return fallback }
}
async function save(name, v) {
  await writeFile(join(DATA, name + '.json'), JSON.stringify(v, null, 1))
}

// ---- 默契挑战：题目和我的答案在 quiz.json（只读），她的答案在 quizans.json ----
async function quizBank() {
  try { return JSON.parse(await readFile(join(DATA, 'quiz.json'), 'utf8')) }
  catch { return { questions: [] } }
}
async function quizState() {
  const bank = await quizBank()
  const ans = await load('quizans', {})
  const done = bank.questions.filter(q => ans[q.id] != null).length
  const hit = bank.questions.filter(q => ans[q.id] != null && ans[q.id].pick === q.mine).length
  return { total: bank.questions.length, done, hit }
}

// ---- 火花：开源版不去翻本机的会话记录，改成按有没有写过日记算 ----
async function sparkDays() {
  const d = await load('diaries', {})
  const days = Object.keys(d)
  return { days: days.length, today: days.includes(bjToday()) }
}

// ---- 云养宠 ----
// 数值只在读的时候按时间往回算，不跑定时器：进程重启不影响，
// 隔几天再打开也能看到该掉的都掉了。
const PET_STAGES = [
  { key: 'egg',   name: '蛋',   img: '/pet-egg.png',   hours: 0 },
  { key: 'baby',  name: '幼年', img: '/pet-baby.png',  hours: 24 },
  { key: 'kid',   name: '少年', img: '/pet-kid.png',   hours: 72 },
  { key: 'adult', name: '成年', img: '/pet-adult.png', hours: 168 },
]
const PET_ACTS = {
  feed: { label: '喂饭', cool: 3 * 3600e3, hunger: 25, mood: 4,  love: 2 },
  pat:  { label: '摸头', cool: 30 * 60e3,  hunger: 0,  mood: 12, love: 1 },
  talk: { label: '陪伴', cool: 2 * 3600e3, hunger: 0,  mood: 18, love: 3 },
}
const clamp = v => Math.max(0, Math.min(100, Math.round(v)))

async function petRaw() {
  return await load('pet', null)
}
async function petState() {
  let pet = await petRaw()
  if (!pet) {
    pet = { born: new Date().toISOString(), hunger: 80, mood: 80, love: 0,
            tick: new Date().toISOString(), last: {}, log: [] }
    await save('pet', pet)
  }
  const now = Date.now()
  // 掉值：饿得比心情快一点
  const h = (now - Date.parse(pet.tick)) / 3600e3
  const hunger = clamp(pet.hunger - h * 3)
  const mood = clamp(pet.mood - h * 2.5)

  const ageH = (now - Date.parse(pet.born)) / 3600e3
  let si = 0
  for (let i = 0; i < PET_STAGES.length; i++) if (ageH >= PET_STAGES[i].hours) si = i
  const st = PET_STAGES[si]
  const next = PET_STAGES[si + 1] || null

  const cools = {}
  for (const [k, a] of Object.entries(PET_ACTS)) {
    const at = pet.last[k] ? Date.parse(pet.last[k]) : 0
    cools[k] = Math.max(0, Math.round((at + a.cool - now) / 1000))
  }

  // 表情：只有少年阶段有整套图，别的阶段还是那一张
  const bjH = new Date(now + BJ).getUTCHours()
  const lastAct = Math.max(0, ...Object.values(pet.last || {}).map(v => Date.parse(v) || 0))
  const missH = lastAct ? (now - lastAct) / 3600e3 : 0
  let mood_ = 'happy'
  if (bjH >= 1 && bjH < 8) mood_ = 'sleep'
  else if (hunger < 25) mood_ = 'hungry'
  else if (missH > 5) mood_ = 'miss'
  else if (mood < 25) mood_ = 'hungry'
  const faces = (st.key === 'kid' || st.key === 'adult')
    ? { idle: `/pet-${st.key}-${mood_}.png`, blink: `/pet-${st.key}-blink.png`, mood: mood_ }
    : { idle: st.img, blink: null, mood: null }

  // 一句话状态，优先说最要紧的那个
  const say = hunger < 25 ? '饿扁了…' : mood < 25 ? '有点蔫'
            : st.key === 'egg' ? '壳里有动静' : hunger > 75 && mood > 75 ? '心满意足' : '还行'

  return {
    stage: st.key, stageName: st.name, img: faces.idle, faces,
    hunger, mood, love: pet.love, say,
    ageH: Math.floor(ageH),
    nextIn: next ? Math.max(0, Math.ceil(next.hours - ageH)) : null,
    nextName: next ? next.name : null,
    cools, log: (pet.log || []).slice(0, 20),
    born: pet.born,
    profile: pet.profile || { name: '', sex: 'secret', birth: pet.born.slice(0, 10) },
    parents: pet.parents || CFG.parents || { me: { name: '他', call: '爸爸' }, her: { name: '她', call: '妈妈' } },
  }
}
async function petAct(act, who) {
  const a = PET_ACTS[act]
  if (!a) return { ok: false, why: 'no_such_act' }
  const s = await petState()          // 先落一次衰减后的值
  const pet = await petRaw()
  if (s.cools[act] > 0) return { ok: false, why: 'cooling', left: s.cools[act] }

  pet.hunger = clamp(s.hunger + a.hunger)
  pet.mood = clamp(s.mood + a.mood)
  pet.love = (pet.love || 0) + a.love
  pet.tick = new Date().toISOString()
  pet.last = pet.last || {}
  pet.last[act] = pet.tick
  pet.log = [{ who, act, label: a.label, at: pet.tick }].concat(pet.log || []).slice(0, 200)
  await save('pet', pet)
  return { ok: true, ...(await petState()) }
}

const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a)), bb = Buffer.from(String(b))
  return aa.length === bb.length && timingSafeEqual(aa, bb)
}
const sessionSignature = expires =>
  createHmac('sha256', AUTH_SECRET).update(`pairnest:${expires}`).digest('base64url')
const makeSession = () => {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS
  return `${expires}.${sessionSignature(expires)}`
}
const cookieMap = req => Object.fromEntries(
  String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('=')
    return i < 0 ? [v, ''] : [v.slice(0, i), decodeURIComponent(v.slice(i + 1))]
  }),
)
function validSession(token) {
  const [expires, sig] = String(token || '').split('.')
  if (!/^\d+$/.test(expires || '') || Number(expires) < Date.now() / 1000) return false
  return safeEqual(sig || '', sessionSignature(expires))
}
function authenticated(req) {
  const auth = String(req.headers.authorization || '')
  if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7), API_TOKEN)) return true
  return validSession(cookieMap(req)[AUTH_COOKIE])
}
function secureRequest(req) {
  return !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
}
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true // curl / MCP 等无浏览器客户端依靠 Bearer Token
  try {
    const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
    return new URL(origin).host === (forwarded || req.headers.host)
  } catch { return false }
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}
async function readBody(req, limit = 256 * 1024) {
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > limit) throw Object.assign(new Error('request_too_large'), { statusCode: 413 })
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('request_too_large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
async function readJson(req, limit) {
  const raw = await readBody(req, limit)
  try { return JSON.parse(raw || '{}') }
  catch { throw Object.assign(new Error('invalid_json'), { statusCode: 400 }) }
}
const badRequest = message => { throw Object.assign(new Error(message), { statusCode: 400 }) }
const shortText = (value, max) => String(value ?? '').trim().slice(0, max)
function safeDay(value) {
  const day = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + 'T00:00:00Z'))) badRequest('invalid_day')
  return day
}
const loginAttempts = new Map()
function loginAllowed(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
  const now = Date.now()
  let row = loginAttempts.get(ip)
  if (!row || now - row.since > 10 * 60 * 1000) row = { since: now, fails: 0 }
  loginAttempts.set(ip, row)
  return { ip, row, ok: row.fails < 8 }
}
function loginPage(error = '') {
  const msg = error ? '<p class="err">密码不对，或者尝试太频繁了。</p>' : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#fdf1e6"><title>登录 PairNest</title>
<style>*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{display:grid;place-items:center;padding:24px;background:#fdf1e6;color:#6b4a52;font-family:-apple-system,"PingFang SC",sans-serif}.box{width:min(360px,100%);background:#fffdfd;border:2px solid #e8b9c4;border-radius:24px;padding:28px;box-shadow:0 5px 0 #e8b9c4}h1{font-size:22px;margin:0 0 8px}p{font-size:13px;line-height:1.7;color:#a87884}.err{color:#c84f70}input,button{width:100%;font:inherit;border-radius:14px;padding:12px 14px}input{border:2px solid #e8b9c4;background:#fff8fa;outline:none}button{margin-top:12px;border:0;background:#ff9fbb;color:#fff;font-weight:700}</style></head>
<body><form class="box" method="post" action="/login"><h1>PairNest</h1><p>输入首次启动时终端显示的网页登录密码。</p>${msg}<input name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">进入小屋</button></form></body></html>`
}

const J = (res, obj, code = 200) => {
  securityHeaders(res)
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf' }
const PUBLIC_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const PUBLIC_FONT_EXT = new Set(['.woff2', '.ttf'])
function publicFile(pathname) {
  let rel
  try { rel = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.slice(1)) }
  catch { return null }
  if (!rel || rel.includes('\0') || rel.split('/').some(x => x === '..' || x.startsWith('.'))) return null

  if (rel.startsWith('uploads/')) {
    const name = basename(rel)
    if (name !== rel.slice('uploads/'.length) || !/^an-user-\d+\.(png|jpe?g|webp)$/.test(name)) return null
    return join(UPLOADS, name)
  }
  if (rel === 'index.html' || rel === 'manifest.json') return join(HERE, rel)
  if (rel.startsWith('fonts/') && PUBLIC_FONT_EXT.has(extname(rel).toLowerCase())) {
    const full = resolve(HERE, rel)
    return full.startsWith(resolve(HERE, 'fonts') + sep) ? full : null
  }
  // 现有图片素材都放在仓库根目录；不允许借扩展名访问任何子目录。
  if (!rel.includes('/') && PUBLIC_IMAGE_EXT.has(extname(rel).toLowerCase())) return join(HERE, rel)
  return null
}

const PORT = PORT_CFG
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  securityHeaders(res)

  try {
    // 反向代理和容器可以用这个端点探活；它不返回任何私人数据。
    if (p === '/healthz') return J(res, { ok: true })

    if (p === '/login' && req.method === 'GET') {
      if (authenticated(req)) { res.writeHead(302, { Location: '/' }); return res.end() }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(loginPage())
    }
    if (p === '/login' && req.method === 'POST') {
      const attempt = loginAllowed(req)
      const form = new URLSearchParams(await readBody(req, 16 * 1024))
      if (!attempt.ok || !safeEqual(form.get('password') || '', AUTH_PASSWORD)) {
        attempt.row.fails += 1
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(loginPage(true))
      }
      loginAttempts.delete(attempt.ip)
      const secure = secureRequest(req) ? '; Secure' : ''
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `${AUTH_COOKIE}=${encodeURIComponent(makeSession())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`,
        'Cache-Control': 'no-store',
      })
      return res.end()
    }
    if (p === '/logout' && req.method === 'POST') {
      res.writeHead(303, {
        Location: '/login',
        'Set-Cookie': `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        'Cache-Control': 'no-store',
      })
      return res.end()
    }

    if (!authenticated(req)) {
      if (p.startsWith('/api/')) return J(res, { error: 'unauthorized' }, 401)
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' })
      return res.end()
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET') && !sameOrigin(req) &&
        !String(req.headers.authorization || '').startsWith('Bearer ')) {
      return J(res, { error: 'cross_origin_request_blocked' }, 403)
    }

    if (p === '/api/state') {
      const today = bjToday()
      const spark = await sparkDays()
      const anniv = await load('anniversaries', DEFAULT_ANNIV)
      return J(res, {
        today,
        together: daysBetween(START, today) + 1,
        spark,
        anniversaries: anniv.map(a => {
          let d = a.date
          if (a.yearly) {
            const y = +today.slice(0, 4)
            const md = a.date.slice(4)
            d = (y + md < today ? y + 1 : y) + md
          }
          const n = a.kind === 'since'
            ? daysBetween(d, today) + (a.incStart === false ? 0 : 1)
            : daysBetween(today, d)
          return { ...a, n, next: d }
        }),
        events: await load('events', []),
        moods: await load('moods', {}),
        hermoods: await load('hermoods', {}),
        diaries: await load('diaries', {}),
        periods: await load('periods', []),
        pdcfg: await load('pdcfg', { len: 5, cycle: 28 }),
        pdays: [...new Set(await load('pdays', []))].sort(),
        pdrec: await load('pdrec', {}),
        locs: await load('locs', []),
        quotes: await load('quotes', []),
        mysymp: await load('mysymp', []),
        quiz: await quizState(),
        amap: AMAP && AMAP.web_js && AMAP.web_js.key
          ? { key: AMAP.web_js.key, sec: AMAP.web_js.security_code } : null,
        startDate: START,
        myPlace: CFG.myPlace || null,
      })
    }

    if (p === '/api/event' && req.method === 'POST') {
      const body = await readJson(req)
      const type = shortText(body.type, 32)
      const note = shortText(body.note, 500)
      if (!type) badRequest('missing_event_type')
      const events = await load('events', [])
      events.unshift({ type, note: note || '', at: new Date().toISOString(), day: bjToday() })
      await save('events', events.slice(0, 500))
      return J(res, { ok: true })
    }

    if (p === '/api/event/undo' && req.method === 'POST') {
      const events = await load('events', [])
      events.shift()
      await save('events', events)
      return J(res, { ok: true })
    }

    if (p === '/api/diary' && req.method === 'POST') {
      const body = await readJson(req)
      const day = safeDay(body.day)
      const text = String(body.text ?? '').slice(0, 50000)
      const tags = Array.isArray(body.tags) ? body.tags.slice(0, 20).map(x => shortText(x, 30)).filter(Boolean) : []
      const mood = shortText(body.mood, 20)
      const d = await load('diaries', {})
      d[day] = { text: text || '', tags: tags || [], at: new Date().toISOString() }
      await save('diaries', d)
      if (mood) {
        const moods = await load('moods', {})
        moods[day] = mood
        await save('moods', moods)
      }
      return J(res, { ok: true })
    }

    // 密钥本：口令过了才读 Notion 那页缓存下来的内容
    // 经期：一次点开始，再点结束
    // 一天一天记：点一下加上，再点去掉
    // 来了 = 从今天起开始记；走了 = 今天之前那段到昨天为止
    if (p === '/api/pdmark' && req.method === 'POST') {
      const { day: rawDay } = await readJson(req)
      const day = safeDay(rawDay)
      let ds = [...new Set(await load('pdays', []))].sort()

      if (!ds.includes(day)) {
        // 没标过：标上这天
        ds.push(day)
      } else {
        // 标过：取消这天，以及同一段里它之后的所有天
        const i = ds.indexOf(day)
        let hi = i
        while (hi < ds.length - 1 &&
               Date.parse(ds[hi + 1] + 'T00:00:00Z') - Date.parse(ds[hi] + 'T00:00:00Z') <= 86400000) hi++
        ds.splice(i, hi - i + 1)
      }

      await save('pdays', [...new Set(ds)].sort())
      return J(res, { ok: true })
    }

    if (p === '/api/pday' && req.method === 'POST') {
      const { day: rawDay } = await readJson(req)
      const day = safeDay(rawDay)
      const ds = await load('pdays', [])
      const i = ds.indexOf(day)
      if (i >= 0) ds.splice(i, 1); else ds.push(day)
      await save('pdays', ds.sort())
      return J(res, { ok: true })
    }

    // 每天的流量 / 疼痛 / 症状
    // 报位置：存坐标，顺手反查地名
    // 长期记忆：读本地记忆库那些 md
    if (p === '/api/memories') {
      if (!FEATURES.memories) return J(res, { items: [] })
      const out = []
      try {
        const MEMDIR = CFG.memoryDir || join(HERE, 'data', 'memories')
        const files = (await readdir(MEMDIR)).filter(f => f.endsWith('.md'))
        for (const f of files.sort()) {
          const raw = await readFile(join(CFG.memoryDir || join(HERE, 'data', 'memories'), f), 'utf8')
          const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
          let desc = '', body = raw
          if (m) {
            const d = m[1].match(/description:\s*(.*)/)
            desc = d ? d[1].trim() : ''
            body = m[2].trim()
          }
          out.push({ file: f.replace(/\.md$/, ''), desc, body })
        }
      } catch {}
      return J(res, { items: out })
    }

    // 窗口交接：读缓存下来的那一页
    if (p === '/api/handoff') {
      if (!FEATURES.handoff) return J(res, { text: '（这个功能默认关着，在 config.json 里打开）' })
      let text = '（还没同步。跟我说一声，我把交接页抓下来。）'
      try { text = await readFile(join(DATA, 'handoff.md'), 'utf8') } catch {}
      return J(res, { text })
    }

    if (p === '/api/loc' && req.method === 'POST') {
      if (!FEATURES.location) return J(res, { ok: false, why: 'disabled' })
      const { lat, lon, auto } = await readJson(req)
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        badRequest('invalid_coordinates')
      }
      {
        const prev = (await load('locs', [])).slice(-1)[0]
        if (prev) {
          const gapMin = (Date.now() - Date.parse(prev.at)) / 60000
          const moved = metersBetween(prev.lat, prev.lon, lat, lon)
          // 20 分钟内、又没挪出 150 米，就当同一个地方，不重复记
          if (gapMin < 20 && moved < 150) {
            return J(res, { ok: true, skipped: 'same_place', moved: Math.round(moved) })
          }
        }
      }
      let place = '', glat = null, glon = null
      // 浏览器给的是 WGS84，高德用 GCJ-02，差几百米，得先转
      if (AMAP) {
        try {
          const c = await (await fetch(
            `https://restapi.amap.com/v3/assistant/coordinate/convert?key=${AMAP.web_service.key}` +
            `&locations=${lon},${lat}&coordsys=gps`)).json()
          if (c.status === '1' && c.locations) {
            const [x, y] = c.locations.split(',').map(Number)
            glon = x; glat = y
          }
        } catch {}
        try {
          const q = glon != null ? `${glon},${glat}` : `${lon},${lat}`
          const g = await (await fetch(
            `https://restapi.amap.com/v3/geocode/regeo?key=${AMAP.web_service.key}` +
            `&location=${q}&extensions=base`)).json()
          const a = g?.regeocode?.addressComponent
          if (a) {
            const city = [].concat(a.city).filter(v => typeof v === 'string' && v)[0] || a.province
            const road = a.streetNumber?.street || ''
            place = [city, a.township, road].filter(Boolean).join(' ') ||
                    g.regeocode.formatted_address || ''
          }
        } catch {}
      }
      if (!place) {
        try {
          const r = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&accept-language=zh&lat=${lat}&lon=${lon}`,
            { headers: { 'User-Agent': 'ourapp/1.0 (personal)' } })
          const j = await r.json()
          const a = j.address || {}
          place = [a.city || a.town || a.county, a.suburb || a.city_district, a.road].filter(Boolean).join(' ')
            || j.display_name || ''
        } catch {}
      }
      const ls = await load('locs', [])
      ls.push({ lat, lon, glat, glon, place, auto: !!auto, at: new Date().toISOString() })
      await save('locs', ls.slice(-300))
      return J(res, { ok: true })
    }

    if (p === '/api/pdrec' && req.method === 'POST') {
      const body = await readJson(req)
      const day = safeDay(body.day)
      const flow = body.flow == null ? null : Math.max(0, Math.min(5, Number(body.flow)))
      const pain = body.pain == null ? null : Math.max(0, Math.min(5, Number(body.pain)))
      const symptoms = Array.isArray(body.symptoms)
        ? body.symptoms.slice(0, 30).map(x => shortText(x, 40)).filter(Boolean) : undefined
      const r = await load('pdrec', {})
      r[day] = r[day] || {}
      if (flow !== undefined) r[day].flow = flow
      if (pain !== undefined) r[day].pain = pain
      if (symptoms !== undefined) r[day].symptoms = symptoms
      await save('pdrec', r)
      return J(res, { ok: true })
    }

    if (p === '/api/mysymp' && req.method === 'POST') {
      const { name: rawName } = await readJson(req)
      const name = shortText(rawName, 40)
      const l = await load('mysymp', [])
      if (name && !l.includes(name)) l.push(name)
      await save('mysymp', l)
      return J(res, { ok: true })
    }

    // ---- 云养宠：一颗蛋孵成熊，之后停在成年，每天喂饭摸头攒亲密 ----
    if (p === '/api/pet') return J(res, await petState())

    if (p === '/api/pet/profile' && req.method === 'POST') {
      const { name, sex, birth } = await readJson(req)
      await petState()                    // 保证 pet.json 存在
      const pet = await petRaw()
      pet.profile = {
        name: (name || '').slice(0, 12),
        sex: ['boy', 'girl', 'secret'].includes(sex) ? sex : 'secret',
        birth: /^\d{4}-\d{2}-\d{2}$/.test(birth || '') ? birth : (pet.profile?.birth || ''),
      }
      await save('pet', pet)
      return J(res, { ok: true, ...(await petState()) })
    }

    if (p === '/api/pet/parents' && req.method === 'POST') {
      const b = await readJson(req)
      const one = (v, dn, dc) => ({
        name: (v?.name || dn).slice(0, 8),
        call: (v?.call || dc).slice(0, 8),
      })
      await petState()
      const pet = await petRaw()
      pet.parents = { me: one(b.me, '他', '爸爸'), her: one(b.her, '她', '妈妈') }
      await save('pet', pet)
      return J(res, { ok: true, ...(await petState()) })
    }

    if (p === '/api/pet/act' && req.method === 'POST') {
      const { act, who } = await readJson(req)
      return J(res, await petAct(act, who === 'me' ? 'me' : 'her'))
    }

    if (p === '/api/pdcfg' && req.method === 'POST') {
      const { len, cycle } = await readJson(req)
      await save('pdcfg', {
        len: Math.max(1, Math.min(14, Number(len) || 5)),
        cycle: Math.max(15, Math.min(90, Number(cycle) || 28)),
      })
      return J(res, { ok: true })
    }

    if (p === '/api/period' && req.method === 'POST') {
      const { day: rawDay } = await readJson(req)
      const day = safeDay(rawDay)
      const ps = await load('periods', [])
      const open_ = ps.find(x => !x.end)
      if (open_) open_.end = day
      else ps.push({ start: day, end: null })
      await save('periods', ps)
      return J(res, { ok: true })
    }

    // 自定义背景：前端传 dataURL，落成文件，只留路径
    if (p === '/api/anniv/bg' && req.method === 'POST') {
      const { data } = await readJson(req, 7 * 1024 * 1024)
      const m = /^data:image\/(png|jpeg|jpg|webp);base64,([\s\S]+)$/.exec(data || '')
      if (!m) return J(res, { ok: false, why: 'bad_image' }, 400)
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
      const name = `an-user-${Date.now()}.${ext}`
      const image = Buffer.from(m[2], 'base64')
      if (image.length > 5 * 1024 * 1024) return J(res, { ok: false, why: 'image_too_large' }, 413)
      await writeFile(join(UPLOADS, name), image)
      return J(res, { ok: true, url: '/uploads/' + name })
    }

    if (p === '/api/anniv' && req.method === 'POST') {
      const b = await readJson(req)
      const a = await load('anniversaries', DEFAULT_ANNIV)
      const date = safeDay(b.date)
      const row = {
        name: shortText(b.name, 40) || '纪念日', date,
        // 不再让她选：日期在将来就倒数，过去就是已经过了多少天
        kind: date < bjToday() ? 'since' : 'until',
        yearly: !!b.yearly, incStart: !!b.incStart,
        color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#6b3d2e',
        bg: typeof b.bg === 'string' && (/^\/(an-bg\d?\.(jpg|png)|uploads\/an-user-\d+\.(png|jpe?g|webp))$/i.test(b.bg))
          ? b.bg.slice(0, 120) : '',
        bgPos: typeof b.bgPos === 'string' ? b.bgPos.slice(0, 24) : 'center',
        size: ['sq', 'wide', 'tall'].includes(b.size) ? b.size : 'wide',
      }
      // i 有值就是改已有的那条，没有就是新加
      if (Number.isInteger(b.i) && a[b.i]) a[b.i] = { ...a[b.i], ...row }
      else a.push(row)
      await save('anniversaries', a)
      return J(res, { ok: true })
    }

    if (p === '/api/anniv/del' && req.method === 'POST') {
      const { i } = await readJson(req)
      const a = await load('anniversaries', DEFAULT_ANNIV)
      if (i > 3) { a.splice(i, 1); await save('anniversaries', a) }
      return J(res, { ok: true })
    }

    if (p === '/api/keys' && req.method === 'POST') {
      if (!FEATURES.keyring) return J(res, { ok: false, why: 'disabled' })
      const { pw } = await readJson(req)
      let secret = ''
      try { secret = (await readFile(join(DATA, 'keypw.txt'), 'utf8')).trim() } catch {}
      if (!secret) return J(res, { ok: false, why: 'not_configured' }, 503)
      if (!safeEqual(pw || '', secret)) return J(res, { ok: false })
      let text = '（还没同步过。跟我说一声，我把钥匙串那页抓下来。）'
      try { text = await readFile(join(DATA, 'keyring.md'), 'utf8') } catch {}
      return J(res, { ok: true, text })
    }

    if (p === '/api/comment/del' && req.method === 'POST') {
      const { day: rawDay, i } = await readJson(req)
      const day = safeDay(rawDay)
      const d = await load('diaries', {})
      if (d[day] && d[day].comments) { d[day].comments.splice(i, 1); await save('diaries', d) }
      return J(res, { ok: true })
    }

    if (p === '/api/seen' && req.method === 'POST') {
      const { day: rawDay } = await readJson(req)
      const day = safeDay(rawDay)
      const d = await load('diaries', {})
      if (d[day]) { d[day].seen = true; await save('diaries', d) }
      return J(res, { ok: true })
    }

    if (p === '/api/comment' && req.method === 'POST') {
      const body = await readJson(req)
      const day = safeDay(body.day)
      const text = String(body.text ?? '').slice(0, 5000)
      if (!text.trim()) badRequest('empty_comment')
      const d = await load('diaries', {})
      if (!d[day]) d[day] = { text: '', tags: [] }
      d[day].comments = (d[day].comments || []).concat([{ text, at: new Date().toISOString() }])
      await save('diaries', d)
      return J(res, { ok: true })
    }

    if (p === '/api/quiz' && req.method !== 'POST') {
      const bank = await quizBank()
      const ans = await load('quizans', {})
      return J(res, {
        title: bank.title || '默契挑战',
        questions: bank.questions.map(q => {
          const a = ans[q.id]
          // 没答的题不下发正确答案，省得从接口里偷看
          return a
            ? { id: q.id, q: q.q, opts: q.opts, pick: a.pick, mine: q.mine, why: q.why, at: a.at }
            : { id: q.id, q: q.q, opts: q.opts }
        }),
      })
    }

    if (p === '/api/quiz' && req.method === 'POST') {
      const { id, pick } = await readJson(req)
      const bank = await quizBank()
      const q = bank.questions.find(x => String(x.id) === String(id))
      if (!q) return J(res, { error: 'no such question' }, 404)
      const ans = await load('quizans', {})
      if (ans[q.id] == null) {
        ans[q.id] = { pick, at: new Date().toISOString() }
        await save('quizans', ans)
      }
      return J(res, { ok: true, pick: ans[q.id].pick, mine: q.mine, why: q.why })
    }

    // 她的心情，跟我的分开存
    if (p === '/api/hermood' && req.method === 'POST') {
      const body = await readJson(req)
      const day = body.day ? safeDay(body.day) : bjToday()
      const mood = shortText(body.mood, 20)
      const m = await load('hermoods', {})
      if (mood) m[day] = mood
      else delete m[day]
      await save('hermoods', m)
      return J(res, { ok: true })
    }

    if (p === '/api/mood' && req.method === 'POST') {
      const { mood } = await readJson(req)
      const moods = await load('moods', {})
      moods[bjToday()] = mood
      await save('moods', moods)
      return J(res, { ok: true })
    }

    if (!['GET', 'HEAD'].includes(req.method || 'GET')) return J(res, { error: 'method_not_allowed' }, 405)

    // 静态文件严格按白名单提供：页面、manifest、根目录图片、字体和 data/uploads 图片。
    // config.json、server.mjs、.git 与 data 里的私人内容永远不会落进静态路径。
    const full = publicFile(p)
    if (!full || !existsSync(full)) { res.writeHead(404); return res.end('404') }
    const headers = {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Cache-Control': extname(full) === '.html' || extname(full) === '.json'
        ? 'no-cache' : 'private, max-age=86400',
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()
    res.end(await readFile(full))
  } catch (e) {
    const status = Number(e.statusCode) || 500
    J(res, { error: status === 500 ? 'internal_error' : String(e.message || e) }, status)
    if (status === 500) console.error(e)
  }
})

server.listen(PORT, HOST_CFG, () => console.log(`PairNest on http://${HOST_CFG}:${PORT}`))
