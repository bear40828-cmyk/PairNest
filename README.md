# PairNest

两个人的小屋：纪念日、心情日记、经期记录、云养宠、档案卡和可选定位。

一个 Node 进程同时提供页面和 API。私人内容保存在本机 `config.json` 与 `data/`，不会写进 Git 仓库。公开部署时整站有登录保护，API 也支持独立 Bearer Token。

## 从零部署

要求：Node.js 20 或更高版本。

```bash
git clone https://github.com/bear40828-cmyk/PairNest.git
cd PairNest
node -v
node server.mjs
```

第一次运行时程序会自动：

1. 创建 `config.json`，权限尽量设为仅当前用户可读写；
2. 创建 `data/`、`data/memories/` 和 `data/uploads/`；
3. 生成随机的网页登录密码、会话密钥和 API Token；
4. 在终端显示一次网页登录密码与 API Token。

先保存终端里的两个值，再打开 `http://127.0.0.1:8795` 登录。`config.json` 已在 `.gitignore` 中，不要把它发给别人或提交到仓库。

首次启动后可编辑 `config.json`，然后重启服务。`config.example.json` 只是字段参考；其中空的鉴权字段会在启动时自动生成。

## 配置

- `host`：默认 `127.0.0.1`。建议保持不变，通过反向代理提供 HTTPS；不要直接把 Node 端口暴露到公网。
- `port`：默认 `8795`。
- `auth.password`：网页登录密码。
- `auth.secret`：登录会话签名密钥，不要共享。
- `auth.apiToken`：给自己的 MCP、脚本或 AI 调用 API 使用，不要放进前端代码。
- `startDate`：在一起的第一天。
- `parents`：档案卡中的名字和称呼。
- `features`：定位、密钥本、长期记忆与交接页开关，默认全关。
- `myPlace`：定位页“我在哪”的显示名和坐标。

也可以用环境变量临时覆盖三个鉴权值：

```bash
PAIRNEST_PASSWORD='新的网页登录密码' \
PAIRNEST_AUTH_SECRET='足够长的随机字符串' \
PAIRNEST_API_TOKEN='单独的随机Token' \
node server.mjs
```

API 调用示例：

```bash
curl -H "Authorization: Bearer 你的API Token" \
  https://你的域名/api/state
```

## 用 HTTPS 给手机访问

定位权限和添加到主屏幕都要求 HTTPS。推荐让 Node 继续只监听 `127.0.0.1`，由 Caddy、Nginx 或 Cloudflare Tunnel 反向代理。

Caddy 示例：

```caddy
pairnest.example.com {
  reverse_proxy 127.0.0.1:8795
}
```

不要把 `config.json`、`data/` 或整个项目目录交给另一个静态服务器公开。PairNest 自带的 Node 服务只会提供以下白名单资源：

- `index.html` 与 `manifest.json`；
- 仓库根目录的图片素材；
- `fonts/` 中的字体；
- `data/uploads/` 中由应用上传的纪念日背景。

`server.mjs`、`.git/`、`config.json` 和其余 `data/` 内容不会通过静态 URL 返回。

## 高德地图 Key：每个使用者必须自己申请

定位功能不能共用原作者或其他人的高德 Key。每个部署者都要登录自己的[高德开放平台](https://console.amap.com/)，为自己的域名分别申请：

1. `Web 服务` Key：服务器坐标转换与逆地理编码使用，填到 `amap.web_service.key`；
2. `Web 端（JS API）` Key 与安全密钥：地图底图使用，填到 `amap.web_js.key` 和 `amap.web_js.security_code`。

Key 的额度、白名单、账单与定位数据都属于申请者自己的账号。**不要把自己的 Key 写进公开仓库、截图、教程示例或发给其他使用者。**

不配置高德时，页面没有高德底图，服务器会尝试使用 OpenStreetMap Nominatim 反查地名。

## 隐私说明

- 日记、经期、宠物、语录等数据保存在本机 `data/*.json`。
- 浏览器提交定位后，精确坐标会先发到你自己的 PairNest 服务器。
- 配置高德时，服务器会把坐标发送给高德做坐标转换和地名反查；未配置高德时会发送给 OpenStreetMap Nominatim。
- 只有从 Telegram WebApp 启动时，页面才加载 Telegram 的 WebApp 脚本；普通浏览器不再固定请求该脚本。
- 登录 Cookie 使用 `HttpOnly` 与 `SameSite=Strict`；经 HTTPS 反代时还会带 `Secure`。

因此“数据在本地”是指 PairNest 不把数据集中上传给项目作者，不代表开启定位后完全不与地图服务通信。

## 手机安装为 PWA

### iPhone / iPad

1. 用 Safari 打开 HTTPS 地址并登录；
2. 点“分享”→“添加到主屏幕”；
3. 首次打开时允许定位权限（只在需要定位时）；
4. 如果从旧版本升级后仍看到顶部状态栏分层，删除旧的主屏幕图标，再从 Safari 重新添加一次，让 iOS 刷新 PWA 元数据。

页面使用 `viewport-fit=cover`、`black-translucent` 和动态安全区高度，状态栏背景会跟随当前页面。

### Android

1. 推荐用最新版 Chrome 打开 HTTPS 地址并登录；
2. 点右上角菜单 → “安装应用”或“添加到主屏幕”；
3. 确认安装，之后可从桌面像普通 App 一样打开；
4. 需要定位时，在浏览器或系统设置中允许该站点使用位置权限。

Edge、Samsung Internet 等支持 PWA 的浏览器也可以安装，菜单名称可能略有不同。如果没有“安装应用”，先确认网站使用 HTTPS、浏览器未处于无痕模式，并刷新页面后重试。旧版本更新后仍显示缓存页面时，卸载桌面上的 PairNest，再清除该站点数据并重新安装。

## 数据与备份

`data/` 下每个 JSON 对应一类数据：

- `anniversaries`：纪念日
- `diaries`：日记
- `moods` / `hermoods`：双方心情
- `periods` / `pdays` / `pdrec` / `pdcfg`：经期
- `locs`：定位轨迹
- `pet`：云养宠
- `quotes`：语录
- `quiz` / `quizans`：默契挑战
- `events`：事件

备份时同时保存 `data/` 和 `config.json`。恢复时放回原位置后重启服务。两者都含私人数据或凭据，不要上传公开网盘或 Git 仓库。

## 换成自己的样子

- `av-me.png` / `av-her.png`：两张占位头像，替换成自己的方图。
- `room3.jpg`：主页背景。
- `pet-egg.png`、`pet-baby.png`、`pet-kid.png`、`pet-adult.png`：宠物四阶段。
- 其余根目录图片为页面素材，可同名替换。

图片替换后如果手机仍显示旧图，可删除主屏幕上的旧 PWA，清除该站点的 Safari 网站数据后重新添加。
