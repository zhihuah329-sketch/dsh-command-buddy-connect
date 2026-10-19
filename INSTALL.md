# 安装说明

## 为什么按包名搜不到

`dsh-command-buddy-connect` **没有发布到 npm，也不在任何插件市场索引里**。
它只存在于作者的机器上，所以「按名字安装」必然报「找不到这个插件」——这不是名字写错，是这个包还没有公开分发。

在发布之前，请用下面任意一种方式安装。

---

## 方式一：用 .tgz 安装（推荐，几分钟）

拿到 `dsh-command-buddy-connect-4.1.1.tgz` 后，任选一种：

### A. 通过 DSH 插件管理界面

1. 打开 DSH → 插件管理
2. 选择「从本地文件安装」，选中这个 `.tgz`
3. 确认启用

### B. 通过命令行

```bash
dsh plugin install_bundle "D:\下载路径\dsh-command-buddy-connect-4.1.1.tgz"
```

### C. 手工改 profile

编辑 `%USERPROFILE%\.dsh\profiles\<你的profile>\package.json`：

```json
{
  "dependencies": {
    "dsh-command-buddy-connect": "file:D:/下载路径/dsh-command-buddy-connect-4.1.1.tgz"
  }
}
```

然后在同目录执行 `pnpm install`，并重启 DSH。

---

## 方式二：从 GitHub 拉源码自建

```bash
git clone https://github.com/zhihuah329-sketch/dsh-command-buddy-connect.git
cd dsh-command-buddy-connect
npm pack --pack-destination dist
```

然后用 `dist/` 下生成的 `.tgz` 按方式一安装。

> 注意：GitHub 上只有源码，**没有打包好的 .tgz**，所以不能直接指向仓库地址安装。

---

## 装好之后还必须做的事

### 1. 确认 WorkBuddy 桌面版已安装并登录

这个插件通过**读取桌面版自己的凭据**来接入账号。国内版会把 token 封在 `$wbEncrypted` 信封里，只有桌面版自己能解开。

- 桌面版装在标准路径（`%LOCALAPPDATA%\Programs\WorkBuddy\`）时，插件会自动找到
- 装在别处（比如 `F:\WorkBuddy\`）时，在 profile 的 `cordis.patch.yml` 里指定：

```yaml
- id: llm-dsh-command-buddy-connect
  config:
    workbuddyPath: 'F:\WorkBuddy\WorkBuddy.exe'
```

### 2. 安装 dsh-workbuddy-connect（用于「从桌面版读取」）

```bash
dsh plugin install_bundle dsh-workbuddy-connect
```

插件用它提供的能力解开加密凭据。**没装不会崩**，但「从桌面版读取」会明确报「找不到 dsh-workbuddy-connect」。
它是 `optionalDependencies`，所以装本插件时不会因为它缺失而失败。

### 3. 导入账号

在插件页面点 **「从桌面版读取」**，国内版和国际版各点一次。
不需要抓包、不需要改系统代理、不需要重启客户端。

---

## 常见问题

**Q：提示「找不到这个插件」**
A：说明你在按包名安装。它还没发布到 npm，请用 .tgz（方式一）。

**Q：号池显示 0 个可用账号**
A：先看每个账号的徽标：
- **额度用尽** → 上游限额，行内会显示重置时间，等到点或换账号
- **需重新登录** → 去桌面版重新登录后，再点「从桌面版读取」
- **已停用 / 已移除** → 在账号列表里重新启用或重新导入

**Q：模型调用报 429**
A：该账号额度或频率受限。多导入几个账号后会自动轮换。

**Q：需要装守护进程 buddyhub 吗**
A：**不需要。** 号池由插件进程内直接提供，签到也由插件自己完成。插件甚至不依赖它。
