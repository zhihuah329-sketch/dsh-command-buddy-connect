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

## 与 BuddyHub 的关系

插件读取 `~/.buddyhub` 下的加密账号库和守护进程配置，因此**已装 BuddyHub 的机器可以直接复用已有账号**，无需重新导入。

不装 BuddyHub 也能用：账号库读不到时插件会明确提示，账号也可以通过本插件自己的页面添加和管理。


---

## 主要能力

### 1. 三分区账号池

页面按 **国内版 / 国际版 / Command Code** 三个折叠区组织，每个区域独立：

- 各自的启用开关（关掉国内版不影响国际版）
- 各自的账号列表与健康状态
- 各自的授权入口

### 2. 自动签到

DSH 启动后自动完成 WorkBuddy 当日签到，结果同步显示在 `buddyhub_*` 工具中。

### 3. 分区域授权

两个区域的凭据性质完全不同，授权方式也不同：

| 区域 | 凭据存储 | 授权方式 |
|---|---|---|
| 国际版 | 明文 JSON | 登录后**直接导入** |
| 国内版 | `$wbEncrypted` 加密 | 登录后**抓取凭据** |

页面会按当前区域的实际情况显示可用按钮，不会让你做无用功。

### 4. 凭据抓取（国内版）

国内版客户端把 token 封装在 `$wbEncrypted` 里，密钥由客户端原生层生成，**无法离线解开**。唯一可靠的方式是读取客户端自己发出的请求。

点击「抓取凭据」后：

1. 在本机生成一张**一次性 CA 证书**（有效期 1 天）
2. 装入「当前用户」信任库
3. 启动本地代理，只拦截 WorkBuddy 相关域名
4. 把系统代理指向它
5. 等待你在客户端登录
6. 抓到 token 后写入号池
7. **自动删除证书、还原代理设置**

> 代理只拦截 `copilot.tencent.com`、`www.workbuddy.cn`、`workbuddy.cn`、`api.workbuddy.cn` 四个域名，其他连接原样转发。会话最长 10 分钟，可随时取消。
>
> 证书**不随安装包分发**，每次在用户本机现场生成，因此任何人拿到这个仓库都无法伪造这些域名的证书。

### 5. 图片输入

三条模型线路都支持图片，图片块会被解析为上游接受的 `image_url`：

```
{ type:'image', attachment: {...} }
  → ctx.attachments.readImageRequest()
  → { type:'image_url', image_url:{ url:'data:image/png;base64,...' } }
```

### 6. Command Code 线路

支持 [Command Code](https://commandcode.ai) 作为外部服务商。API Key 由用户自己在页面填写，存在 `~/.dsh-command-buddy-connect/`（权限 0600），**不随安装包分发**。

---

## 安装

```bash
npm pack
# 然后在 DSH 插件管理器中加载生成的 .tgz
```

### 依赖

- DeepSeek Harness `0.2.1-rc.2`
- 可选：[BuddyHub](https://github.com/OHCJ099/BuddyHub)（提供加密账号库与守护进程）

没有 BuddyHub 时，插件会尝试直接读取账号库；读取不到会明确提示，而不是静默失败。

---

## 配置

在 DSH 的 `cordis.patch.yml` 中：

```yaml
dsh-command-buddy-connect:
  autoCheckin: true       # 启动时自动签到
  checkinTime: "09:00"    # 定时签到时间
  enableLocalPool: true   # 启用国内版 / 国际版号池
  enableProvider: true    # 启用 BuddyHub 守护进程线路
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
| `buddyhub_status` | 查询签到状态与账号池健康 |
| `buddyhub_checkin` | 立即执行签到 |
| `buddyhub_accounts` | 列出各区域账号及状态 |
| `buddyhub_import` | 从本机凭据文件导入账号 |

---

## 数据位置

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/.buddyhub/accounts.enc` | BuddyHub 加密账号库（只读） | — |
| `~/.dsh-command-buddy-connect/command-code.json` | Command Code API Key | 0600 |
| `~/.dsh-command-buddy-connect/routes.json` | 区域开关状态 | — |
| `~/.dsh-command-buddy-connect/capture/` | 抓包用临时证书（1 天有效） | 0600 |

---

## 开发

```bash
npm test           # 单元测试
npm pack           # 打包 .tgz
```

### 项目结构

```
index.js            # 宿主侧：路由、工具、适配器注册
client.js           # 页面侧：三分区 UI
lib/
  proxy.js          # 反代规则（轮询、会话亲和、错误映射）
  local-adapter.js  # 进程内号池适配器
  adapter.js        # BuddyHub 守护进程适配器
  cc-adapter.js     # Command Code 适配器
  command-code.js   # CC 协议转换（纯函数）
  image-wire.js     # 图片块 → image_url
  account-status.js # 账号状态推导、凭据发现、导入
  capture.js        # 凭据抓取会话
  cert-gen.js       # 运行时证书生成（纯 JS DER 编码）
  vault.js          # BuddyHub 账号库解密
```

### 设计原则

- **声明必须真实**：`inputModalities` 声明了 image 就必须真的转发图片，否则模型会以为看过它没收到的图
- **失败要说清原因**：静默返回 0、看起来像「成功但什么都没做」，是最糟的体验
- **宁可不做，不做错**：找不到国际版客户端时报告「未安装」，而不是打开国内版客户端
- **清理必须可靠**：装过的证书、改过的代理，任何退出路径都要还原

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
