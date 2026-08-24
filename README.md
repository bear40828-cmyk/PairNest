# PairNest

两个人的小屋：纪念日、心情日记、经期记录、云养宠、档案卡。
纯静态页面 + 一个 Node 进程，数据全在本地 `data/` 目录下的 json 文件里，不上传任何地方。

## 给 AI 的部署说明

照下面几步做，全程不需要人动手：

1. 需要 Node 20 以上。`node -v` 确认。
2. `cp config.example.json config.json`，按下面「要填的东西」改。
3. `node server.mjs` 启动，默认监听 `127.0.0.1:8795`。
4. 想让手机也能开：套一层 https（Cloudflare Tunnel、Caddy、Nginx 都行）。
   **必须是 https**，否则浏览器不给定位权限，PWA 也装不了。
5. 想开机自启就写一个 systemd service，`ExecStart` 指向 `node /绝对路径/server.mjs`。

## 要填的东西（config.json）

- `startDate`：在一起的第一天，主页的天数从这天开始算。
- `parents`：两个人的称呼，档案卡上显示。
- `port`：端口，跟别的服务撞了就改。
- `features`：四个开关，**默认全关**，按需要自己打开：
  - `location` 定位与轨迹
  - `keyring` 密钥本
  - `memories` 长期记忆（读 `data/memories/*.md`）
  - `handoff` 交接页（读 `data/handoff.md`）
- `amap`：高德地图的 key，不填也能用，只是地图没有底图，地名反查会退到 OpenStreetMap。

## 数据

`data/` 下面每个 json 就是一类数据，能直接看、直接改、直接备份：

anniversaries 纪念日 / diaries 日记 / moods 心情 / hermoods 对方的心情 /
periods、pdays、pdrec、pdcfg 经期 / locs 定位 / pet 云养宠 / quotes 语录 /
quiz、quizans 默契挑战 / events 事件

**备份就是把 `data/` 整个拷走。**

## 换成自己的样子

- 图片素材全在根目录，同名替换就行。
- **头像要自己放**：`av-me.png` 和 `av-her.png` 仓库里没有，放两张方图进去即可。
- 其余素材（小熊、房间、纪念日、像素定位那套）都可以直接用。
- 主页背景 `room3.jpg`，宠物四阶段 `pet-egg/baby/kid/adult.png`。
- 默契挑战的题目在 `data/quiz.json`，格式照着文件里的字段写。

## 不带走的东西

这份代码里没有任何原作者的私人数据：日记、定位、语录、密钥本全部是空的，
头像和「长期记忆 / 交接页」这类私人功能默认关闭。
