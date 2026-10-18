# DSH Command Buddy Connect

一个 **DeepSeek Harness (DSH)** 插件，让模型流量走区域账号池，并附带 WorkBuddy 自动签到。

核心是一套插件自带的线路调度：国内版、国际版、Command Code 三条线路彼此独立，各自轮询、各自开关、各自诊断。账号库由插件自己解析，签到由插件自己排程，不需要任何后台常驻进程。

## 它做什么

| 能力 | 说明 |
|---|---|
| 区域号池 | 国内版 / 国际版分区独立轮询，会话亲和，SSE 归一化 |
| 线路开关 | 三条线路可单独停用，停用即刻生效，互不影响 |
| 每日签到 | 启动时自动完成 WorkBuddy 当日签到，可定时可手动 |
| 账号诊断 | 每个账号的可用性、冷却、到期、可续期状态一目了然 |
| 凭据抓取 | 国内版凭据加密时，在本机抓取一次请求完成接入 |
| Command Code | 作为独立服务商接入，密钥由用户自己填写 |

## 设计取向

- **声明必须真实**：一条线路声明支持图片，就必须真的转发图片字节
- **失败要说清原因**：静默返回 0、看起来像成功却什么都没做，是最糟的体验
- **宁可不做，不做错**：找不到国际版客户端就报「未安装」，而不是打开国内版客户端
- **清理必须可靠**：装过的证书、改过的代理，任何退出路径都要还原
- **校验放在写入方**：只在调用方检查等于没检查，任何新调用者都会重新打开那个洞
- **报告要能对应现实**：抓到了但没写进去、点了但窗口没出现，都属于「假成功」，比失败更糟

---

## 主要能力

### 1. 三分区账号池

页面按 **国内版 / 国际版 / Command Code** 三个折叠区组织，每个区域独立：

- 各自的启用开关（关掉国内版不影响国际版）
- 各自的账号列表与健康状态
- 各自的授权入口

### 2. 账号管理

账号库里的每个账号都能单独控制：

| 操作 | 说明 |
|---|---|
| 参与签到 | 关掉后该账号不再自动签到，但仍可用于模型调用 |
| 刷新凭证 | 用新令牌替换旧凭据，标签、站点、统计全部保留 |
| 删除 | 从号池移除，**先自动备份**，可从备份目录恢复 |

签到开关是插件自己的记录（`~/.dsh-command-buddy-connect/checkin.json`），不写账号库——账号库的 `enabled` 字段含义是“能否用于模型调用”，两件事绑在一起会让用户为了停签而丢掉模型线路。

删除采用**墓碑**而不是直接删除条目：守护进程每次启动都会从客户端重新导入凭据，而账号 id 是 `sha256(site:uid:enterpriseId)` 的哈希，删掉的条目会被立刻重新导入。墓碑保留 id、清空令牌、把过期时间设到 2100 年，导入器判定“没有更新的凭据”就跳过它。刷新凭证可以解除墓碑。

### 3. 自动签到

DSH 启动后自动完成 WorkBuddy 当日签到，**号池里每个 CN 账号都会访问**，结果按账号列出。国际版的计费接口对这些请求返回 401，所以只签国内版。

### 4. 分区域授权

两个区域的凭据性质完全不同，授权方式也不同：

| 区域 | 凭据存储 | 授权方式 |
|---|---|---|
| 国际版 | 明文 JSON | 登录后**直接导入** |
| 国内版 | `$wbEncrypted` 加密 | 登录后**抓取凭据** |

页面会按当前区域的实际情况显示可用按钮，不会让你做无用功。

两个版本的可执行文件元数据和安装目录名完全一样，只有客户端的数据目录能区分区域（国内版是 `%APPDATA%\CodeBuddy CN`）。所以国际版授权不会误开国内版客户端。

### 5. 凭据抓取（国内版）

国内版客户端把 token 封装在 `$wbEncrypted` 里，密钥由客户端原生层生成，**无法离线解开**。唯一可靠的方式是读取客户端自己发出的请求。

点击「抓取凭据」后：

1. 在本机生成一张**一次性 CA 证书**（有效期 1 天）
2. 装入「当前用户」信任库
3. 启动本地代理，只拦截 WorkBuddy 相关域名
4. 把系统代理指向它
5. 等待你在客户端登录
6. 抓到 token 后写入号池，**更新原账号而不是新建**
7. **自动删除证书、还原代理设置**

> **抓取前必须关闭网络层代理（TUN 模式）。**
>
> 抓取依赖修改 Windows 的*系统代理*。Clash/Mihomo 的 TUN 模式、sing-box、WireGuard 之类在 IP 层接管流量，位置比系统代理更低，客户端根本不会读那个设置——抓包端口一个连接都收不到，会话只能等超时。
>
> 插件会检测这类虚拟网卡并在开始前阻止抓取，告诉你具体是哪个适配器，而不是让你重启客户端白等十分钟。
>
> 两条出路：临时关掉 TUN 抓一次，或者跳过抓取、直接用「刷新凭证」粘贴令牌。

> 代理只拦截 `copilot.tencent.com`、`www.workbuddy.cn`、`workbuddy.cn`、`api.workbuddy.cn` 四个域名，其他连接原样转发。会话最长 10 分钟，可随时取消。
>
> 证书**不随安装包分发**，每次在用户本机现场生成，因此任何人拿到这个仓库都无法伪造这些域名的证书。

> **账号身份取自令牌本身。** 号池用 `sha256(site:uid:enterpriseId)[:20]` 作为账号 id，匹配错了就会新建一个空账号而不是更新。真实 CN 流量不带 `x-user-id` 请求头，所以 uid 从令牌的 `sub` 声明读取——它与号池里存的 uid 一致。

### 6. 图片输入

三条模型线路都支持图片，图片块会被解析为上游接受的 `image_url`：

```
{ type:'image', attachment: {...} }
  → ctx.attachments.readImageRequest()
  → { type:'image_url', image_url:{ url:'data:image/png;base64,...' } }
```

### 7. Command Code 线路

支持 [Command Code](https://commandcode.ai) 作为外部服务商。API Key 由用户自己在页面填写，存在 `~/.dsh-command-buddy-connect/`（权限 0600），**不随安装包分发**。

---

## 安装

```bash
npm pack
# 然后在 DSH 插件管理器中加载生成的 .tgz
```

### 依赖

- DeepSeek Harness `0.2.1-rc.2`
- 无其他必需依赖

账号库由插件自己解析，不依赖任何后台常驻进程。读取不到账号库时会明确提示，而不是静默失败。

---

## 配置

在 DSH 的 `cordis.patch.yml` 中：

```yaml
dsh-command-buddy-connect:
  autoCheckin: true       # 启动时自动签到
  checkinTime: "09:00"    # 定时签到时间
  enableLocalPool: true   # 启用国内版 / 国际版号池
  enableProvider: true    # 启用守护进程线路
  enableCommandCode: true # 启用 Command Code 线路
  commandCodeApiBase: "https://api.commandcode.ai"
  dataDir: null           # 账号库目录，默认 ~/.buddyhub
```

> **不要把 API Key 写进配置文件。** Command Code 的密钥在插件页面上填写，存在 `~/.dsh-command-buddy-connect/command-code.json`。

---

## 工具

插件向 Agent 暴露以下工具：

| 工具 | 作用 |
|---|---|
| `checkin_status` | 查询签到状态与积分 |
| `checkin_now` | 立即执行签到 |
| `checkin_schedule` | 查看或调整定时签到 |
| `pool_accounts` | 列出各区域账号及可用性 |
| `pool_import` | 从本机凭据文件导入账号 |
| `buddy_connect_pools` | 按区域汇总号池真实状态 |
| `buddy_connect_diagnose_import` | 诊断单个凭据文件为何无法导入 |
| `daemon_status` | 查询本地守护进程线路的健康 |
| `daemon_logs` | 读取守护进程最近的日志 |

---

## 数据位置

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/.buddyhub/accounts.enc` | 加密账号库（只读读取） | — |
| `~/.dsh-command-buddy-connect/command-code.json` | Command Code API Key | 0600 |
| `~/.dsh-command-buddy-connect/routes.json` | 区域开关状态 | — |
| `~/.dsh-command-buddy-connect/checkin.json` | 每个账号的签到开关 | 0600 |
| `~/.dsh-command-buddy-connect/capture/` | 抓包用临时证书（1 天有效） | 0600 |

---

## 开发

```bash
npm run verify                        # 单元测试 + 完整性检查（提交前跑这个）
npm test                              # 只跑单元测试
npm run check                         # 只跑完整性检查
npm run e2e -- 5724                   # 对运行中的宿主做真实接口验证
npm run pack:tgz                      # 打包到 dist/
```

> `npm run verify` 里的完整性检查不是可选项。单元测试只导入单个模块，看不到「前端加载失败」「处理器调了没导入的函数」「写库接受了无效令牌」这三类问题——它们都真的发生过，而单测全绿。

### 项目结构

```
index.js            # 宿主侧：路由、工具、适配器注册
client.js           # 页面侧：三分区 UI
lib/
  proxy.js          # 反代规则（轮询、会话亲和、错误映射）
  local-adapter.js  # 进程内号池适配器
  adapter.js        # 本地守护进程适配器
  cc-adapter.js     # Command Code 适配器
  command-code.js   # CC 协议转换（纯函数）
  image-wire.js     # 图片块 → image_url
  account-status.js # 账号状态推导、凭据发现、导入
  capture.js        # 凭据抓取会话
  cert-gen.js       # 运行时证书生成（纯 JS DER 编码）
  tunnel.js         # 检测会让抓取失效的网络层代理
  vault.js          # 账号库解密
  vault-edit.js     # 账号库写入（删除、刷新凭证，带备份与回滚）
  checkin-all.js    # 多账号签到
  checkin-prefs.js  # 每个账号的签到开关
  scheduler.js      # 签到调度
  router-state.js   # 线路开关持久化
  state-dir.js      # 状态目录解析（兼容旧名）
test/
  *.test.js            # 单元测试（node --test）
  integrity-check.mjs  # 导入可解析、无未定义调用、CSS 模板完整
  e2e-live.mjs         # 对运行中的宿主做真实接口验证
```

### 设计原则

- **声明必须真实**：`inputModalities` 声明了 image 就必须真的转发图片，否则模型会以为看过它没收到的图
- **失败要说清原因**：静默返回 0、看起来像「成功但什么都没做」，是最糟的体验
- **宁可不做，不做错**：找不到国际版客户端时报告「未安装」，而不是打开国内版客户端
- **清理必须可靠**：装过的证书、改过的代理，任何退出路径都要还原
- **校验放在写入方**：只在调用方检查等于没检查，任何新调用者都会重新打开那个洞
- **报告要能对应现实**：抓到了但没写进去、点了但窗口没出现，都属于「假成功」，比失败更糟

---

---

## 从旧名升级

插件原名 `buddy-connect`，现名 `dsh-command-buddy-connect`。升级时：

- **配置和密钥不会丢失**：状态目录仍是 `~/.buddy-connect/`（新装机器才用新目录名）
- **已选的模型不受影响**：provider id 仍是 `buddy-connect` / `buddyhub` / `command-code`，它们是模型 id 的一部分，改名会让历史会话找不到模型
- **需要卸载旧包**：两个包注册同一个 provider 会冲突，请先移除旧的 `buddy-connect` 再安装新版

---

## 许可

MIT
