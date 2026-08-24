// PairNest —— 两个人的小屋。所有私人内容都在 config.json 和 data/ 里，代码本身不带任何个人信息。
import { createServer } from 'node:http'
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, 'data')
// 刚 clone 下来是没有 data 目录的（里面的东西都被 gitignore 了），先建出来
await mkdir(join(DATA, 'memories'), { recursive: true })
// 端口在 config.json 里改
// ---- 配置：照着 config.example.json 复制一份改成 config.json ----
let CFG = {}
try { CFG = JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8')) } catch {}
const PORT_CFG = CFG.port || 8795
const FEATURES = Object.assign(
  { location: false, keyring: false, memories: false, handoff: false },
  CFG.features || {},
)

// 高德地图：不填就退回免费的 Nominatim 反查，只是没有地图底图
const AMAP = CFG.amap || null

// 在一起的第一天，写在 config.json 里
const START = CFG.startDate || '2026-01-01'
const BJ = 8 * 3600 * 1000

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

const J = (res, obj, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf' }

const PORT = PORT_CFG
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname

  try {
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
        amap: AMAP ? { key: AMAP.web_js.key, sec: AMAP.web_js.security_code } : null,
      })
    }

    if (p === '/api/event' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { type, note } = JSON.parse(body || '{}')
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
      let body = ''
      for await (const c of req) body += c
      const { day, text, tags, mood } = JSON.parse(body || '{}')
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
      let body = ''
      for await (const c of req) body += c
      const { day } = JSON.parse(body || '{}')
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
      let body = ''
      for await (const c of req) body += c
      const { day } = JSON.parse(body || '{}')
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
      let body = ''
      for await (const c of req) body += c
      const { lat, lon, auto } = JSON.parse(body || '{}')
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
      let body = ''
      for await (const c of req) body += c
      const { day, flow, pain, symptoms } = JSON.parse(body || '{}')
      const r = await load('pdrec', {})
      r[day] = r[day] || {}
      if (flow !== undefined) r[day].flow = flow
      if (pain !== undefined) r[day].pain = pain
      if (symptoms !== undefined) r[day].symptoms = symptoms
      await save('pdrec', r)
      return J(res, { ok: true })
    }

    if (p === '/api/mysymp' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { name } = JSON.parse(body || '{}')
      const l = await load('mysymp', [])
      if (name && !l.includes(name)) l.push(name)
      await save('mysymp', l)
      return J(res, { ok: true })
    }

    // ---- 云养宠：一颗蛋孵成熊，之后停在成年，每天喂饭摸头攒亲密 ----
    if (p === '/api/pet') return J(res, await petState())

    if (p === '/api/pet/profile' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { name, sex, birth } = JSON.parse(body || '{}')
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
      let body = ''
      for await (const c of req) body += c
      const b = JSON.parse(body || '{}')
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
      let body = ''
      for await (const c of req) body += c
      const { act, who } = JSON.parse(body || '{}')
      return J(res, await petAct(act, who === 'me' ? 'me' : 'her'))
    }

    if (p === '/api/pdcfg' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { len, cycle } = JSON.parse(body || '{}')
      await save('pdcfg', { len: len || 5, cycle: cycle || 28 })
      return J(res, { ok: true })
    }

    if (p === '/api/period' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { day } = JSON.parse(body || '{}')
      const ps = await load('periods', [])
      const open_ = ps.find(x => !x.end)
      if (open_) open_.end = day
      else ps.push({ start: day, end: null })
      await save('periods', ps)
      return J(res, { ok: true })
    }

    // 自定义背景：前端传 dataURL，落成文件，只留路径
    if (p === '/api/anniv/bg' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { data } = JSON.parse(body || '{}')
      const m = /^data:image\/(png|jpeg|jpg|webp);base64,([\s\S]+)$/.exec(data || '')
      if (!m) return J(res, { ok: false, why: 'bad_image' }, 400)
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
      const name = `an-user-${Date.now()}.${ext}`
      await writeFile(join(HERE, name), Buffer.from(m[2], 'base64'))
      return J(res, { ok: true, url: '/' + name })
    }

    if (p === '/api/anniv' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const b = JSON.parse(body || '{}')
      const a = await load('anniversaries', DEFAULT_ANNIV)
      const row = {
        name: b.name, date: b.date,
        // 不再让她选：日期在将来就倒数，过去就是已经过了多少天
        kind: b.date < bjToday() ? 'since' : 'until',
        yearly: !!b.yearly, incStart: !!b.incStart, color: b.color || '#6b3d2e',
        bg: typeof b.bg === 'string' ? b.bg.slice(0, 80) : '',
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
      let body = ''
      for await (const c of req) body += c
      const { i } = JSON.parse(body || '{}')
      const a = await load('anniversaries', DEFAULT_ANNIV)
      if (i > 3) { a.splice(i, 1); await save('anniversaries', a) }
      return J(res, { ok: true })
    }

    if (p === '/api/keys' && req.method === 'POST') {
      if (!FEATURES.keyring) return J(res, { ok: false, why: 'disabled' })
      let body = ''
      for await (const c of req) body += c
      const { pw } = JSON.parse(body || '{}')
      let secret = '0721'
      try { secret = (await readFile(join(DATA, 'keypw.txt'), 'utf8')).trim() } catch {}
      if (pw !== secret) return J(res, { ok: false })
      let text = '（还没同步过。跟我说一声，我把钥匙串那页抓下来。）'
      try { text = await readFile(join(DATA, 'keyring.md'), 'utf8') } catch {}
      return J(res, { ok: true, text })
    }

    if (p === '/api/comment/del' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { day, i } = JSON.parse(body || '{}')
      const d = await load('diaries', {})
      if (d[day] && d[day].comments) { d[day].comments.splice(i, 1); await save('diaries', d) }
      return J(res, { ok: true })
    }

    if (p === '/api/seen' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { day } = JSON.parse(body || '{}')
      const d = await load('diaries', {})
      if (d[day]) { d[day].seen = true; await save('diaries', d) }
      return J(res, { ok: true })
    }

    if (p === '/api/comment' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { day, text } = JSON.parse(body || '{}')
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
      let body = ''
      for await (const c of req) body += c
      const { id, pick } = JSON.parse(body || '{}')
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
      let body = ''
      for await (const c of req) body += c
      const { day, mood } = JSON.parse(body || '{}')
      const m = await load('hermoods', {})
      if (mood) m[day || bjToday()] = mood
      else delete m[day || bjToday()]
      await save('hermoods', m)
      return J(res, { ok: true })
    }

    if (p === '/api/mood' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { mood } = JSON.parse(body || '{}')
      const moods = await load('moods', {})
      moods[bjToday()] = mood
      await save('moods', moods)
      return J(res, { ok: true })
    }

    // 静态
    const file = p === '/' ? 'index.html' : p.slice(1)
    const full = join(HERE, file)
    if (!full.startsWith(HERE) || !existsSync(full)) { res.writeHead(404); return res.end('404') }
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(await readFile(full))
  } catch (e) {
    J(res, { error: String(e.message || e) }, 500)
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`PairNest on 127.0.0.1:${PORT}`))
