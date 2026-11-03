# dsh-fingerprint

DSH Web UI 左侧栏的「**指纹检测**」面板：勾选你已配置的模型 → 设轮次 → 跑 LM Fingerpoint Detection（`lmfpd-sdk`）→ 得到模型排名表。

**状态**：`tests: 157 passing` · `selfcheck: 29 checks` · `license: MIT` · 包版本 `0.1.0`

---

## 这是什么 / 给谁用

给**任何已经装好 DSH、并且配了至少一个模型**的人用。装完会在左侧栏多出一行「指纹检测」，点开是整页：选择模型 → 跑若干轮「指纹挑战」→ 看模型在参考库里的封闭排名。

**一句话架构**：前端只做 UI + `fetch`，一切模型调用与指纹逻辑都在**宿主侧**，走 DSH 自己的
`ctx.llm.stream()` —— 因此：

- ✅ **不碰你的 API Key**（明文 key 只在宿主侧解析，前端拿不到）；
- ✅ **任何 DSH 配置都能跑**：不新增 provider、不改你的 settings、不写你的凭据。

---

## 前置要求

| 项 | 要求 |
|---|---|
| DSH 版本 | 见 `package.json` 的 `engines.dsh`：`>=0.2.1-rc.2 <0.3.0-0` |
| Node.js | `>= 22`（见 `engines.node`） |
| 依赖 | **克隆后必须先 `npm install`** —— 仓库**不含** `node_modules/`（见「安装」） |
| 网络 | **首次运行**需下载约 **3.6 MB** 参考数据（缓存到 `%LOCALAPPDATA%\lmfpd\data.bin`） |
| 账号 | 无要求 —— 用你自己已配好的模型 |

### `engines.dsh` 的放行范围（以及末尾那个 `-0` 是干什么的）

当前值：**`engines.dsh = ">=0.2.1-rc.2 <0.3.0-0"`**（以 `package.json` 为准）。
下表是用 **DSH 自己的判定函数**实测出来的
（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility(manifest, {}, version)`），
**不是**普通 semver 工具的结论：

| DSH 版本 | 放行？ |
|---|---|
| `0.2.0` | ✖ |
| `0.2.1-rc.1` | ✖ |
| `0.2.1-rc.2`（下界） | ✔ |
| `0.2.1-rc.3`（写作时的当前版） | ✔ |
| `0.2.1` | ✔ |
| `0.2.2-rc.1` | ✔ |
| `0.2.5-rc.1` | ✔ |
| `0.2.9` | ✔ |
| `0.3.0-rc.1` | ✖ |
| `0.3.0` | ✖ |
| `0.4.0-rc.1` | ✖ |
| `1.0.0` | ✖ |

**一句话**：**保留全部 `0.2.x`（含 `-rc`），完全拒绝 `0.3.x`（含它的 `-rc`）**。

#### 为什么末尾是 `<0.3.0-0` 而不是 `<0.3.0`？

因为我们想要的语义是"**只用 `0.2.x` 这一代**"，而 `<0.3.0` **做不到这件事**：

> DSH 判定时带了 **`{ includePrerelease: true }`**
> （`dsh-app-boot/lib/index.js:277`；`:303` 注释原文 *"Prereleases participate in ranges."*）。
> 这个选项让**预发布版本像普通版本一样参与范围比较**。
> 于是 `<0.3.0` 不仅放行 `0.2.9`，还会放行 **`0.3.0-rc.1`** —— 因为按 semver 的比较规则
> `0.3.0-rc.1 < 0.3.0` 成立。

| 上界写法 | `0.2.9` | `0.3.0-rc.1` | `0.3.0` |
|---|---|---|---|
| `<0.3.0`（**意图**是只用 0.2.x） | ✔ | **✔ ⚠️ 漏了** | ✖ |
| `<0.3.0-0`（我们采用的） | ✔ | **✖** | ✖ |

`-0` 是 semver 里"最小的预发布"标记：`<0.3.0-0` 表示"**连 `0.3.0` 的预发布也算超界**"。
⇒ **`<0.3.0` 在最需要严的地方反而松**；`<0.3.0-0` 才是唯一"既保留全部 `0.2.x`、又彻底拒绝 `0.3.x`"的写法。

> ⚠️ **顺带纠正一个容易搞反的点**：**预发布本身不是陷阱**。
> 带 `includePrerelease` 时，`0.2.2-rc.1` / `0.2.5-rc.1` 这类运行时会**正常被放行** ——
> 如果你用普通 semver 的**默认**选项去测，会得到"它们被拒绝"的相反答案。
> **这正是必须调用 DSH 自己那份实现的原因**（见下）。

> 📌 上表按**当前** `package.json` 里的 `engines.dsh` 值计算。**该值以 `package.json` 为准**；它一旦改动，请重算本表。
> 重算的最省事办法：`node tools/selfcheck.mjs --judge-matrix --dsh-pkg <你的安装目录>/node_modules/@deepseek-ai/dsh/package.json`
> —— 它会把"自研实现"与"DSH 自己的实现"逐格对比，不一致就点出来。

### 什么时候才需要「版本豁免」

**只有当 DSH 真的拒绝加载本插件时**（启动输出里出现 `skipping profile bundle "dsh-fingerprint"`
或 `pluginCompatibilityWarning`）才考虑下面的豁免。**否则不要用** —— 原因见下面的风险提示。

DSH 自带按 `name@version` 加白名单的子命令。下面三条 usage 是**实测**出来的
（触发其校验报错、让它自己打印 usage；**未执行任何有副作用的命令**）：

```
$ dsh plugin --profile desktop version-exemptions probe-extra-arg
dsh: Error: usage: dsh plugin version-exemptions

$ dsh plugin --profile desktop allow-version
dsh: Error: usage: dsh plugin allow-version <package@version> --dsh-version <exact> --accept-risk

$ dsh plugin --profile desktop revoke-version
dsh: Error: usage: dsh plugin revoke-version <package@version> --dsh-version <exact>
```

于是：

```powershell
# 看当前已有哪些豁免
dsh plugin --profile <profile> version-exemptions

# 给「本插件的这个版本 + 你这个 DSH 版本」这一对加白名单
dsh plugin --profile <profile> allow-version dsh-fingerprint@0.1.0 --dsh-version <你的DSH版本> --accept-risk

# 撤销
dsh plugin --profile <profile> revoke-version dsh-fingerprint@0.1.0 --dsh-version <你的DSH版本>
```

> 🚨 **这个命令有真实风险，DSH 自己会警告你。** 执行 `allow-version … --accept-risk` 时它会打印：
> ```
> dsh: warning: allowing incompatible plugin versions can break the application or corrupt data.
> Approval applies only to the exact package and DSH versions.
> ```
> （`dsh/lib/plugin-BiveYA7h.js:36`）而 `dsh-app-boot/lib/index.js:335` 的原文更重：
> *"Running it may cause crashes or data loss."*
>
> ⇒ **不要把豁免当成常规安装步骤**。它只应在你**确实被 skip、并且明确接受这个风险**时使用。
> 更稳妥的做法是到仓库里开个 issue 说明你用的 DSH 版本 —— 只有 DSH 跨到 `0.3.x`（或更高）时才真的需要本插件更新 `engines.dsh`；`0.2.x` 的**任意** RC 本来就都被放行。
> ⚠️ **我们不应该为了绕过一个并不存在的问题，而让任何人去执行一个真有风险的动作。**

⚠️ 两点实测更正/提醒：
1. **`revoke-version` 也需要 `--dsh-version`**（上面是命令自己打印的 usage 原文）。
2. 豁免**精确到"包版本 + DSH 版本"这一对**：换插件版本或换 DSH 版本都**不继承**，要重新加。

> ⚠️ 另注：`dsh plugin --help` **只记录 pnpm 透传**（`add` / `remove` / `why`），**不记录**上面这些 DSH 自有子命令 —— 所以别指望从 `--help` 里找到它们。

---

## 安装

> 下文的占位符：`<profile>` = 你的 profile 名（如 `desktop`、`web`）；`<DSH_HOME>` = DSH 的 home 目录（默认 `~/.dsh`，环境变量 `DSH_HOME` 可覆盖）；`<plugin-dir>` = 本仓库/插件所在目录。

### ⚠️ 先装依赖（干净克隆必做）

**本仓库不携带 `node_modules/`**（`.gitignore` 里有 `node_modules/`），所以**克隆下来必须先装依赖**，否则测试跑不起来：

```powershell
cd <plugin-dir>
npm install          # 只装 1 个运行时依赖：lmfpd-sdk
```

| 命令 | 干净克隆（未 `npm install`） | 装了依赖后 |
|---|---|---|
| `node --test` | ❌ **会失败** —— `ERR_MODULE_NOT_FOUND: lmfpd-sdk` | ✅ 全绿 |
| `node tools/selfcheck.mjs` | ✅ **可跑**（只 import Node 内置模块） | ✅ 可跑 |
| `node tools/selfcheck.mjs --self-test` | ✅ **可跑**（零依赖） | ✅ 可跑 |
| `node tools/client-smoke.mjs` | ✅ **可跑**（只 import Node 内置模块） | ✅ 可跑 |

⇒ 也就是说：**静态自检、夹具自测、客户端冒烟这三个都是零依赖的，克隆下来立刻能跑**；只有单元/集成测试需要先 `npm install`。

> ℹ️ 关于**方式 A**（下面的 `dsh plugin add`）：它是把参数直通给 pnpm 的，**pnpm 通常会顺带把依赖装上** —— 但**我没有实测证实这一点**（那要真的改一个 profile），所以这里**标注为"未证实"**。装完若 `node --test` 报 `lmfpd-sdk` 找不到，就在 `<plugin-dir>` 里手动 `npm install` 一次。

### 方式 A（推荐）：让 DSH 自己装

```powershell
dsh plugin --profile <profile> add github:Practice019/dsh-fingerprint
```

这一条会**自动**把包追加进你 profile 的 `dsh.profile.bundles`
（`dsh-plugin-manager/lib/types/operations.js:558-559` → `reconcile` → `:116-117`），
所以不需要你手工编辑 profile。

⚠️ **`desktop` profile 是特例（重要）**：

| profile | 怎么装 |
|---|---|
| **非 `desktop`**（如 `web`、自定义） | 直接跑上面那条 CLI 命令即可 |
| **`desktop`** | 它由 **Electron 应用独占管理**：普通 `dsh` CLI 入口会**直接拒绝**（`dsh/lib/bin.js:36-38`：`profile "desktop" is managed exclusively by the Electron application`）。<br>**首选**用应用内 **Web UI → 侧栏「插件」页**安装（走 HMR 重新组合，安全）。<br>若一定要用 CLI：必须用**应用随附**的那条 `dsh.cmd`（它显式传了 `manageDesktopProfile: true`），并且**先完全退出**应用。 |

> ⚠️ **`dsh.cmd` 路径陷阱**：请用**应用安装目录**下
> `resources\runtime\cli\bin\dsh.cmd` 这一条。
> `resources\app\runtime\...` 那条是**坏的**：`app\runtime` 是指向 `runtime` 的 junction，
> 而脚本用 `%~dp0..\..\..\..\DeepSeek Harness.exe` 做相对解析，cmd 不解析 junction，上溯层数就错了。

### 方式 B（本地开发）：junction 手装

适合**你想改代码**的场景：零 pnpm、零 profile 副作用，改完本地立即生效，回滚只需删一个链接。

```powershell
# ① 建 junction（目标必须尚不存在；已存在就先把它删掉）
cmd /c mklink /J "<DSH_HOME>\profiles\<profile>\node_modules\dsh-fingerprint" ^
                 "<plugin-dir>"

# ② 在 profile 的 package.json 里登记依赖（必须是 link: 形式）
#    文件：<DSH_HOME>\profiles\<profile>\package.json
#    "dependencies": { "dsh-fingerprint": "link:<plugin-dir 的绝对路径，正斜杠即可>" }

# ③ 把包名追加进 dsh.profile.bundles（顺序 = 补丁应用顺序，放最后即可）
#    同一个文件：
#    "dsh": { "profile": { "bundles": [ ... , "dsh-fingerprint" ] } }
```

⚠️ **方式 B 与"依赖"是两件事**：方式 B 只是**挂载**（把目录链接进 profile），它**不会**替你装依赖 —— 所以**上面那条 `npm install` 一样要做**。
（换句话说：方式 B 省掉的是"profile 层再解析一遍依赖"这件事，因为 `lmfpd-sdk` 已经装在**插件目录自己的** `node_modules/` 里了。）

**为什么"进 bundles"和"有 `dsh.bundle.patch`"缺一不可：**

- 进了 `bundles` 但包本身没有 `dsh.bundle.patch` → 该 bundle 被**跳过**（`dsh-app-boot/lib/index.js:1024` 抛 `declares no dsh.bundle in its package.json`，进 `skippedBundles`，stderr 打一行）。
- 有 `dsh.bundle.patch` 但没进 `bundles` → 它的 patch **根本不会被读**（`index.js:1016, 1020`）。
- 真正把插件挂进 Loader 的，是 `cordis.patch.yml` 里的 `- insert: [{ id: fingerprint, name: dsh-fingerprint }]`。

装完**改一次** `<DSH_HOME>\profiles\<profile>\cordis.patch.yml`（哪怕只加一个空行），或重开 DSH，让 profile 重新组合。

### 关于 `dsh.install` 字段

`package.json` 里有 `dsh.install` 块（给市场/安装器看的偏好信息）。**当前 DSH 没有任何运行时消费者读它**（对 6 个相关包 grep 无命中）—— 它是**元数据**，装上之后不需要你关心。

---

## 怎么验证已挂载

### ① 跑自检脚本（最快、可复现）

```powershell
cd <plugin-dir>
node tools/selfcheck.mjs             # 有 FAIL → 退出码 1；全 PASS → 0
node tools/selfcheck.mjs --json      # 机器可读
node tools/selfcheck.mjs --self-test # 夹具自测：证明各检查项既可达 PASS 也可达 FAIL
```

它逐条校验 **29 项**（C1–C14 装载清单 + X1–X7 契约/发布/私有标识附加 + S1–S7 槽位语义 + R1 回滚备件），覆盖：字段合规、`dsh.bundle.patch` 与 `dsh.client` 约束、`exports` 目标是否存在、insert 行 id/name、junction 是否指向正确目录、profile 依赖与 bundles、`client.js` 是否为 classic script、**每个 `require()` 实参是否都在 11 个外壳种子词白名单内**（防"require 了磁盘上不存在的包"）、**槽位注册字面量是否与契约一致**（panellist id、main key 一致性、order、label 形式与**实际中文值**、`module.exports.inject`）、**发布就绪性**（`engines.dsh` 覆盖运行时、`license`、无 `private`）、以及**私有标识残留**（`X7`：应入库文件里不含私有标识）。只读，不改任何文件。

> 标记类检查（C10/C11/C12/C13/X3 + S1–S7）一律在**剥离注释后的代码视图**上判定：注释里出现 `window.__ModuleLoader__.load(` 或 `export function apply` 这类字样**不算命中**（早期版本会被注释骗过，报假 PASS）。
>
> 仓库里若出现 `.smoke.json`，那是开发期诊断产物，**自检刻意忽略它**。

### ② DSH「设置 → 插件」清单页看 Loader 条目阶段

打开 Web UI → 设置 → 插件 → 插件列表（`ui-settings-plugin-inventory`，数据源 `@deepseek-ai/dsh-host-plugin-inventory` 的 `pluginInventory/list`）。找到 id 为 `fingerprint` 的那一行，看**存活阶段**：

| 阶段 | 含义 |
|---|---|
| `active` | 已挂载并在运行 ✅ |
| `pending` / `loading` | 等待/正在加载 |
| `failed` | fiber 被拒绝 —— 打开启动失败日志看原因 |
| `unloading` | 正在拆除 |
| `null` | 完全没有存活根 fiber（从未启动，或已被释放） |

侧栏的**插件**页（`ui-plugin-manager`）也能看错误，并提供「允许这些脚本并重试」。

### ③ 侧栏是否出现「指纹检测」

左侧栏出现标签为 **指纹检测**、order=40 的行。点开能出整页（勾选模型 / 轮次 / 排名表），说明客户端束也被宿主编译并投递成功。

若侧栏没有该行 → 客户端束没加载；若点行报 `main panel "<id>" is not registered` → `client.js` 里 `main` 槽位注册的 `key` 与 `panellist` 的 `id` 不一致。

---

## 生效机制（改完要做什么才能看到效果）

HMR 在 profile-backed 启动下**默认开启**（`dsh-base` 组合包以 `root: []` 启用 `@deepseek-ai/dsh-hmr`），但 `root: []` 表示**只监听配置，不监听源码目录**。

| 你改了什么 | 要做什么 | 依据 |
|---|---|---|
| `lib/index.js`（宿主半侧） | 触发一次 profile 重新组合：**改一次** `<DSH_HOME>\profiles\<profile>\cordis.patch.yml`（或用 Web 插件页做任意一次插件操作）。然后刷新页面/重建会话即可，**无需重启 DSH**。 | 已链接插件目标在原地被改动后，会在下一次 profile 重新组合时被替换（`dsh-hmr/README.zh.md:49`） |
| `client.js`（浏览器半侧） | **什么都不用做**：写盘后由 client-hmr 轮询（默认每 500 ms 比对入口产物的 mtime/ctime/size）自动替换该插件。**不需要刷新页面**，也不重启 Host。注意被重载插件的 React 状态会丢，会话/连接状态保留。 | `dsh-client-hmr/README.zh.md:12, :42` |
| `package.json` 的 `main` / `exports` | **必须重启 DSH**。源码重载仍会用已加载的模块，改入口映射不会生效。 | `dsh-hmr/README.zh.md:75` |
| `package.json` 的依赖字段 | 仅依赖字段变化**不会**触发配置重载。 | `dsh-plugin-manager/README.zh.md:102` |
| 想让 `lib/index.js` **保存即生效** | 在 `<DSH_HOME>\profiles\<profile>\cordis.patch.yml` 加 `- id: hmr` / `disabled: false` / `config: { root: ["."] }`，然后**重启一次**让监听生效。 | `dsh-hmr/README.zh.md:27-34, :43` |

> 注意：`client.js` 是**构建产物**、需要手动写出（生产安装没有 `pnpm run dev:web` 那样的 bundle watcher）；写出动作本身就推进了 revision。

---

## 排错

**启动失败日志**：`<DSH_HOME>\logs\startup-<ISO时间>-<uuid>.log`

- 该目录**按需创建**：没失败过就不存在，属正常。
- 只在启动审计失败（`StartupError`）时生成，内容含完整诊断，权限 0600。终端会打印 `Full diagnostics: <路径>`。
- 依据：`dsh/lib/bin.js:159-195`。

**包操作日志**：`<DSH_HOME>\profiles\<profile>\.plugin-manager\logs\operation-*\pnpm.log`

- 每次 pnpm 操作一个目录；失败时终端会打印 `dsh: plugin command failed; diagnostics: <路径>`。
- 另有 `github-connection-*\git.log`（GitHub 安装前连通性检查）。
- 依据：`dsh-plugin-manager/lib/types/operations.js:305-309`。

**CLI 路径陷阱**：见上文「方式 A」下的提示 —— 用 `resources\runtime\cli\bin\dsh.cmd`，不要用 `resources\app\runtime\...`。

**其他常见现象**：

- 侧栏无「指纹检测」→ 客户端束没挂上：查 `/plugins/dsh-fingerprint/client.js` 是否 200，以及「设置→插件」里该条目阶段。
- 点行报 `main panel "dsh-fingerprint" is not registered` → `main` 槽位的 `key` 与 `panellist` 的 `id` 不一致（自检 **S2** 专抓这条）。
- 侧栏行的位置不对 → `order` 不是 40（自检 **S3**）。
- 侧栏显示的文字不是「指纹检测」→ `label` 追到的字典值不对（自检 **S7**；它会打印 `label → t("键") → zh.键 = 实际值` 这条链，并同时核对 `en` 字典有没有同键）。
- 点开整页但语言不切换 / `t()` 不生效 → `module.exports.inject` 少了 `locale`（自检 **S5**）。
- 面板渲染成空白/整格被 retire → 很可能是渲染了 `undefined`（图标取不到必须回退内置 SVG）。
- 模型列表为空 → 宿主在无凭据时不会从目录里补模型；模型列表以 settings 里的 `models` 数组为主来源。
- `require("...")` 运行时报 module miss → 用了 11 个外壳种子词以外的模块名（磁盘上不存在），跑 `node tools/selfcheck.mjs` 的 C12 会直接点名。
- 启动输出里出现 `skipping profile bundle "dsh-fingerprint"` → `engines.dsh` 与你的 DSH 版本不匹配，见上文「预发布陷阱」与逃生口。

---

## 回滚

按顺序，任一步都可停（方式 B 手装的话）：

1. **删 junction**
   ```powershell
   cmd /c rmdir "<DSH_HOME>\profiles\<profile>\node_modules\dsh-fingerprint"
   ```
   （`rmdir` 对 junction 只删链接，不会删目标内容；**不要**用 `Remove-Item -Recurse`。）
2. **从 profile `package.json` 移除登记**：删 `dependencies` 里的 `"dsh-fingerprint"` 一行，再删 `dsh.profile.bundles` 里的 `"dsh-fingerprint"` 项。
   - 若你之前把 profile 清单备份成 `package.json.bak-fingerprint`（**装本插件之前**的快照），也可以直接还原它。它在不在由自检的 **R1** 每次现场判定 —— 本 README 不写死结论。
3. **删插件目录** `<plugin-dir>`（`node_modules/lmfpd-sdk` 会一并删掉；要重新装就再 `npm install lmfpd-sdk`）。
4. 最后改一次 `cordis.patch.yml`（或重开 DSH）让 profile 重新组合。

方式 A 装的更简单：在 Web UI 侧栏「插件」页点卸载（或 `dsh plugin --profile <profile> remove dsh-fingerprint`）。

> **一条方法论备注**：本 README 的早期版本曾把"某备份文件不存在"当作**结论**写下来，而它其实只是一次**时间点采样** —— 文件在几分钟后被创建，文档立刻变成假话。
> 所以现在凡是"某文件在不在"这类断言，**一律交给自检现场判定**，文档只写"怎么判定"。这条已升级为团队标准：**跨时刻的观察不得写成结论**。

---

## 已知风险

- **首次运行要下载参考数据**：`lmfpd-sdk` 的 `loadDetector()` 首次会下载约 **3.6 MB** 参考数据，缓存到 `%LOCALAPPDATA%\lmfpd\data.bin`。首次调用会慢、且**需要网络**；离线环境会失败（探测器保持 `ready: false`，`/fingerprint/status` 里能看到 `error`）。之后走缓存。
- **Node 走代理需要显式开关**：Node 24 默认**不读** `HTTP_PROXY` / `HTTPS_PROXY` 等环境变量。若下载或模型调用要过代理，必须设 `NODE_USE_ENV_PROXY=1`（否则表现为连接超时）。
- **`engines.dsh` 只在 DSH 跨到 `0.3.x`（或更高）时才需要动**：发布包**必须**声明 `engines.dsh`（自检 **C7** 强制），且它的范围**必须**覆盖你的运行时；但 **`0.2.x` 的任意 RC（`0.2.1-rc.4`、`0.2.5-rc.1`…）都不需要更新它** —— DSH 判兼容时带 `includePrerelease`，全部 `0.2.x` 预发布本就放行。详见上文「`engines.dsh` 的放行范围」。
  （本地开发期的取舍正好相反：那时我们刻意**不声明**它，以避免不兼容时被宿主 skip —— 发布语义是本条。）
- **同时声明 `@deepseek-ai/dsh*` peerDependencies 是无效的**：只要 `engines.dsh` 存在，宿主就**只看它、忽略全部 dsh peer**（`dsh-app-boot/lib/index.js:301-304`）。自检把这种写法记 **INFO**，不判 FAIL，但建议删掉以免误导。
- **密钥只在宿主侧**：明文 key 前端取不到（`credentials.describe()` 只回 `{configured,source?,writable}`），所以模型调用与指纹逻辑全在宿主侧，前端只做 UI + `fetch`。
- **不要往插件目录装宿主包**：`node_modules/@deepseek-ai/` 必须为空/不存在，否则模块解析会出现第二份 `@deepseek-ai/*` 副本（自检 **C14** 会报 FAIL）。插件目录的 `node_modules` 顶层**只应**有 `lmfpd-sdk`。
- **`private` 不能为 `true`**：那会阻止 `npm publish`（自检 **X6** 会报 FAIL）。

### 残余项（已知、已接受，如实保留）

- **访问控制的边界**：`/fingerprint/*` 只挡「浏览器页面 / 跨站 / DNS rebinding」这类**来自浏览器的**访问。**本机任意进程若自行伪造 `Host` 头仍可绕过** —— 裸 `webServer` registry 不继承 DSH Connection 的认证。**真正的进程级隔离需要 DSH 认证层或防火墙策略**，不在本插件范围内。⇒ 不要把 `/fingerprint/*` 当成"本机进程隔离"来依赖。
- **`ranking[]`（完整排名表 8 字段）只有静态核对**：它只在真实模型跑出 `decision='scored'` 时才有内容；为省额度**未做真机端到端**。补齐成本很小 —— **1 模型 × 1 轮 = 3 次请求**。
- **休眠 provider 不产生行（设计，非缺陷）**：休眠目录项在 settings 里**没有 `models`** ⇒ 产出 0 行 ⇒ **「未启用（N）」分组在真机不会出现**。⇒ **若你在页面上找不到那个分组，那是正确的**，不是 bug。
- **运行队列未实现**：`POST /fingerprint/run` 在已有运行中任务时返回 `BUSY`（`{code:'BUSY', runId}`）。客户端会**自动接上**那个正在跑的任务，但**无法排队开第二个**。

---

## 自检脚本

```powershell
node tools/selfcheck.mjs                    # 人类可读，逐条 PASS/FAIL/SKIP + 证据
node tools/selfcheck.mjs --json             # 汇总 JSON（含 pending 清单）
node tools/selfcheck.mjs --self-test        # 夹具自测（证明各检查项能红能绿）
node tools/selfcheck.mjs --plugin <目录> --profile-dir <profile 目录>   # 指定别处
node tools/selfcheck.mjs --dsh-version <ver>                            # 指定 C7 的判定对象（CI / 手动复核）
node tools/selfcheck.mjs --dsh-pkg <@deepseek-ai/dsh/package.json 路径>  # 指定动态读取源 + DSH 判定引擎（非标准安装布局）
node tools/selfcheck.mjs --judge-matrix                                 # 打印判定矩阵，核对自研实现 vs DSH 自己的实现
```

- 退出码：有 `FAIL` → `1`；否则 `0`。参数缺失 → `2`。
- 默认插件目录 = 本脚本的上一级；默认 profile 目录 = `$DSH_HOME/profiles/desktop`（`DSH_HOME` 未设时用 `~/.dsh`）。**不是这两个就用 `--plugin` / `--profile-dir` 覆盖。**
- `SKIP` 用于"文件尚未就绪"，**不计 FAIL**，但会在汇总里单独列出为「待产出项」。
- **严格只读**：不写任何文件、不改配置、不重启 DSH。

**检查项清单（共 29 项）**

| 组 | 编号 | 内容 |
|---|---|---|
| 装载清单 | C1–C14 | 字段合规 / `dsh.bundle.patch` / `dsh.client` 约束 / `exports` 目标 / insert 行 / **`engines.dsh` 覆盖运行时** / junction / profile 登记 / 客户端束四项 / 宿主入口 / 不装宿主包 |
| 契约附加 | X1–X4 | `version`=0.1.0、`name`=dsh-fingerprint、仅 `lmfpd-sdk` 依赖、`client.js` 的 `inject` 存在 |
| **发布就绪** | **X5–X6** | `license`=`MIT`、`private` 不为 `true` |
| **私有标识残留** | **X7** | **应入库的文件里不含私有标识**（见下） |
| 槽位语义（形式） | S1–S6 | panellist `id`、main `key` 一致性、`order`、`label` **形式**、`module.exports.inject`、存在 `name: "main"` 的页面注册 |
| 槽位语义（值） | **S7** | `label` 的**实际中文值**是否等于冻结的「指纹检测」 |
| 可回滚性 | R1 | profile 的 `package.json.bak-fingerprint` 是否存在且可解析（**现场判定，不在文档里写死**） |

### X7：应入库的文件里不含私有标识

**查什么**：插件目录下**应入库的文件**里不得出现冻结词表中的**私有标识** —— 本机绝对路径 / 本机用户名 / 私有环境变量名 / 私有 provider·产品族名。

**两套判据同时跑**（防"工具漏"）：① 独立 token 正则（**决定 PASS/FAIL**）；② 裸子串 `includes`（交叉核对）。①漏掉、②找到的地方会作为**"第三种漏法"的探针**打印出来。三种写法都覆盖：引号包裹 / **裸键** / **URL 查询**。

**排除集**（输出里会逐条打印理由）：
| 排除 | 为什么 |
|---|---|
| `node_modules/` | 依赖目录：非本仓库作者所写，且被 `.gitignore` 忽略、不入库 |
| `.git/` | 版本库内部结构：不是"应入库的文件" |
| `.smoke.json` | 未被 git 跟踪 + 在 `.gitignore` 内 + 每次 `runSmoke()` 覆盖写的开发期产物（**里面必然含本机绝对路径**） |

另排除二进制扩展名（`png` / `woff` / `asar` 等）。

**刻意不算命中的三类**（否则一上线就误报）：
1. **合成哨兵** —— 测试里的密钥"长成密钥的样子"是故意的（若出现在输出里测试即红）；
2. **公开名** —— `deepseek-official` / `deepseek-account` / `deepseek-chat` / `openai` / `anthropic` / `DEEPSEEK_API_KEY` / `DEEPSEEK_ACCOUNT_API_KEY` / `DEEPSEEK_OFFICIAL_API_KEY` / `DSH_FINGERPRINT_*` / `@deepseek-ai/*` / `api.deepseek.com` / `127.0.0.1` / RFC1918·RFC5737 / `family:"deepseek"` / `familyName:"DeepSeek"`；
3. **数字型证据** —— 端口 `2418`、order `40`、各类计数。

> ⚠️ **作用域说明（别把 X7 当通用脱敏审查）**：X7 查的是**一份冻结词表** —— 它只保证「**已登记的标识不复发**」，**不替代通用脱敏审查**：**不在词表里的新私有标识，它抓不到**。
> 实测过：随手造一个词表外的 `sk-…` 形式串放进文件，X7 不会报 —— 这是**设计如此**（通用 `sk-` 前缀规则会误伤测试里的合成哨兵）。
> ⇒ **新增 provider / 换机器 / 接入新服务之后**，仍然需要人对照契约 §49.1 把新标识**登记进词表**，X7 才会开始守它。

### ⚠️ 给后人的两条说明（都是防误判的，别"修正"）

**① 词表是"碎片拼接"存放的 —— `grep` 不到明文词条是故意的，不是词表丢了。**
`tools/selfcheck.mjs` 里的词表与夹具输入写成 `needle('loo', 'm', 'y')` 这种**碎片拼接**，所以**文件里不存在任何完整词条**。
原因：**X7 会扫描包括它自己在内的所有文件**。如果词表是明文，每次运行都会命中它自己，于是只剩两条坏路 —— 把该文件加进排除集（**等于给自己开后门**，正是"范围不足"的温床），或让检查永远红（**等于没有这项检查**）。碎片拼接让检查可以**在不给自己开豁免的前提下扫自己**。
⇒ 代价：人肉 `grep` 找不到明文词条。**要确认词表内容请看契约 §49.1，不要以为它丢了。**

**② 两个私有 provider 名的处理是"刻意的非对称"—— 不要"修正"成对称。**
下面用 `provider_a` / `provider_b` 作**代称**（**代称不是真实名字**；真实词表见 `tools/selfcheck.mjs` 的词表定义，它以碎片形式存放）：
- `provider_a`：**认**"引号里只有它自己"这种形态。
- `provider_b`：**只认**键名上下文与 URL 查询这两类。
原因：`provider_b` 单独出现在引号里、在测试代码中太常见（测试框架名、用例名），**认它会立刻误报并杀死这项检查** —— **误报比漏报更早杀死一项检查**。

> 📌 这段文字最初刻意用**粗体**而不是反引号，就是为了避开 X7 —— **反引号包裹本身就是 X7 判定命中的形态之一**。换成 `provider_a` / `provider_b` 这类**代称**之后它们不在词表里，用反引号就没问题了。
> 实测过：直接用真名 + 反引号会让这份 README **自己**触发 X7 —— `node tools/selfcheck.mjs` 从 `PASS 29 / FAIL 0` 变成 `PASS 28 / FAIL 1`，报"私有名（引号/反引号包裹）2 处"。**文档自己也得是干净的。**

**C7 是发布语义**：本地开发时我们**刻意不声明** `engines.dsh`；发布则**必须声明**且覆盖运行时。判定过程会完整打印（判定对象、判定引擎、每个比较子是否通过）。

> 🚨 **C7 判定必须用 DSH 自己的实现，不能自己重写一遍。** 这一点是踩过坑的：
> DSH 用的是 `semver.satisfies(version, range, { includePrerelease: true })`
> （`dsh-app-boot/lib/index.js:277`），而**自研实现写成标准 semver 默认语义**时，
> 会把 `0.2.2-rc.1` / `0.3.0-rc.1` 这类运行时**误判为 FAIL** —— 一个纯假阴性，
> 而 DSH 正在发 rc 版，随时会踩到。
>
> 所以 C7 现在按下面的优先级取「判定引擎」，并**在输出里注明用的是哪一个**：
>
> | 优先级 | 引擎 | 输出里的标注 | 说明 |
> |---|---|---|---|
> | 1 | **DSH 自己的 `evaluatePluginCompatibility`** | `判定引擎 = DSH 自己的实现（evaluatePluginCompatibility）` | 直接 `import` 已装 DSH 的 `dsh-app-boot/lib/index.js`，**不可能与 DSH 语义不一致** |
> | 2 | 自研 semver 实现（兜底） | `判定引擎 = 自研 semver 实现（兜底）` | 按 `includePrerelease` 语义实现，并**自曝"可能随 DSH 变动而失真"** |
>
> 想核对这两个引擎是否还一致 —— 跑 `node tools/selfcheck.mjs --judge-matrix`（加上 `--dsh-pkg` 指向你的安装目录）：
> 它会把两个引擎在「12 个版本 × 14 种 range 写法 = 168 个组合」上**逐格对比**，不一致就点出来并让退出码非零。
> 写作时的实测结果是 **不一致 0 处 ✔**。

**C7 的判定对象（运行时 DSH 版本）按三级取值**，每次运行的输出里都会用「**来源：…**」注明实际用了哪一路：

| 优先级 | 路径 | 输出里的来源标注 | 维护方式 |
|---|---|---|---|
| 1 | `--dsh-version <ver>` 显式指定 | `来源：--dsh-version 显式指定` | 由调用方负责（CI / 手动复核） |
| 2 | 动态读取已装 DSH（按候选表读 `@deepseek-ai/dsh/package.json` 的 `version`） | `来源：动态读取 @deepseek-ai/dsh/package.json` | **自动** —— DSH 升级后无需改本仓库 |
| 3 | 回落硬编码常量 | `来源：硬编码常量 —— 采集时刻 <日期>，可能已过时` | **需人工更新常量**（见下） |

> ⚠️ **这条维护义务别漏**：**走动态路径时是自动的**（读到什么就按什么判）；**一旦回落到硬编码常量，就必须人工更新它** —— 否则 C7 会给出**错误结论**（不是"过时提示"，是**判错**）。
> 判断当前是否在回落：看输出头部的 `C7 判定对象: …（来源：…）` 那一行 —— 只要写着"硬编码常量"，就说明动态读取没命中。
> 非标准安装布局（例如 `@deepseek-ai/dsh` 不在常规位置）可以用 `--dsh-pkg <路径>` 指给它。

**S7 是怎么追值的**（S4 只判形式，值这件事必须单独追）：

```
label: () => t("nav")                       ← client.js 里 panellist 注册的 label（thunk）
  ↓ 抽出字典键
"nav"
  ↓ 定位字典：优先选实参命名空间与 panellist 的 locale: NS 一致的那条 locale.register
locale.register(NS, { zh: ZH, en: enTable() })
  ↓ 解析 zh 表达式（支持多跳）
ZH → const ZH = { ... }                     ← 冒号属性
EN ← enTable() → function enTable(){ return EN; }   ← 无参调用 + return 两跳
  ↓
zh.nav = "指纹检测"  ===  冻结值 "指纹检测"   ✔
en.nav 键存在 ✔（只核对键存在性，不校验英文值）
```

抽取器的兼容面（都有夹具覆盖）：**冒号属性**、**ES6 简写** `{ zh, en }`、**内联对象**、**多跳**、**一个文件里多套字典**（按 `locale:` 选对表）、以及完全没有 `locale.register` 时回退到 `const ZH`/`const EN` 约定。任一步取不到 → **FAIL**（不 SKIP）。

**`--self-test` 是什么**：把合成输入喂给与真实检查**同一份**判定函数，断言每一项在"应红"的夹具上真的红、在基准夹具上真的绿。之所以需要它 —— 拿现成的第三方包做反例只能证明部分项能红（那个包在若干项上本来就合规），只有自造输入才能证明每一项都不是死代码。

当前规模（**采样**，采集时刻见 §22.1）：四组共 **18 + 34 + 9 + 19 = 80 个夹具**、**126 + 115 + 21 + 44 = 306 个断言**：

| 组 | 夹具 | 项 | 断言 |
|---|---|---|---|
| 槽位语义 S1–S7 | 18 | 7 | 126 |
| 发布清单 C7 / X5 / X6（含三级取值各红各绿、A vs B 边界、引擎接入） | 34 | 3 | 102 状态 + 13 证据 |
| C7 判定对象的三级取值解析器 | 9 | 2 | 18 状态 + 3 来源标签 |
| **私有标识 X7**（含排除集、公开名不误伤、漏法探针） | **19** | — | **44**（逐夹具按 `expect` 字段） |

并逐项报告"可达 PASS / 可达 FAIL"（X7 组报"可判 FAIL / 可判 PASS 的夹具数"），均须 > 0。

---

## 交付前必跑：四连

改完插件（任何文件）后，**按顺序**跑这四条。**注意每条的前置条件不同**（见下）：

```powershell
cd <plugin-dir>
npm install     # ← 前置：干净克隆先装依赖（否则 ④ 跑不起来；①②③ 零依赖、可先跑）

# ① 装载自检：29 项逐条 PASS/FAIL/SKIP + 证据；有 FAIL → 退出码 1
#    ⚠️ 前置：插件必须**已装进 profile**（junction + profile 登记）——
#       因为 C8 判 junction、R1 判回滚备件，**干净克隆上必然 FAIL**。
#       只想看代码、没装 profile 的人请跳过 ①，跑 ②③④ 即可。
node tools/selfcheck.mjs

# ② 夹具自测：零依赖、不碰 profile，任何环境都能跑
node tools/selfcheck.mjs --self-test

# ③ 客户端运行时冒烟：24 场景 × 2 模式 = 48 次运行；零依赖、不碰 profile
node tools/client-smoke.mjs

# ④ 单元/集成测试全量：需要先 npm install
node --test
```

判定标准：

| 步骤 | 前置条件 | 通过条件 | 本轮实测（**采样，不是硬结论**） |
|---|---|---|---|
| ① | **插件已装进 profile**（干净克隆上 C8/R1 必然 FAIL） | **`FAIL 0`**（`SKIP` 若出现，说明有文件尚未就绪，交付前必须变成 `PASS`） | `PASS 29 / FAIL 0 / SKIP 0`，退出码 0 |
| ② | **无**（零依赖、不碰 profile） | **`断言不符 0 处；不可达项 0 项`** | 306 断言（四组），各项均可达 PASS 且可达 FAIL |
| ③ | **无**（零依赖、不碰 profile） | **`FAIL 0`**（**注意：不是"PASS 数固定"**，见下） | `PASS 837 / SKIP 5 / FAIL 0`，退出码 0 |
| ④ | **已 `npm install`** | **`ℹ fail 0`**（判定标准就是 fail 0，条数会随增测变化） | `ℹ tests 157 / pass 157 / fail 0` |

> ⚠️ **③ 的判定标准是 `FAIL 0`，不要写死 PASS 条数**。它有两种模式，`PASS` 数会随模式不同而变：
> - `primitives-present`：**SKIP 必须为 0**；
> - `primitives-absent`：会有 5 条 SKIP（原语缺失时的降级路径本来就不该断言原语行为）—— 所以 `SKIP 未计入 PASS` 是设计如此，不是缺陷。
>
> ③ 自身还带**两道自检闸门**（违反即 `process.exit(1)`），这是它能当交付门禁的前提：
> 1. **守恒不变式**：`present(PASS)` 必须等于 `absent(PASS + SKIP)`。两模式都跑时才判定，防止"运行期按模式分叉、却没走检查"的断言被漏掉。
> 2. **断言数下限**（`ASSERTION_FLOOR`，逐场景登记）：防止**整条断言被删除**——删掉后两个模式会一起变少、依然守恒，静默少测在报告里完全不可见。下限只升不降；调低必须在回报里说明理由。
>
> 上表"本轮实测"列是**带采集时刻的采样**，不是"这东西永远等于这个数"的结论。**判定永远看"通过条件"那一列。**

> ① ② 都**严格只读**：不写任何文件、不改配置、不重启 DSH。③ ④ 只跑被测代码，也不改交付文件。
>
> ⚠️ 若要核对"文件是否被改动"，请比对你自己记录的基线哈希 —— 例如 `README.md` 与 `tools/selfcheck.mjs` 会因修文档/校验器而正常变更，不要把它们混进"不该变"的清单。

---

## 怎么验证门禁闸门（复跑手法）

交付四连的 ③（`tools/client-smoke.mjs`）自带两道**防虚高**的闸门。本节记录怎么**独立复核**它们真的会红 —— 供后人重做，不必新增脚本。

> ⚠️ **只在 `%TEMP%` 副本上做，绝不改被测文件。** 验完必须复核原件哈希未变。

### 准备：把被测脚本复制到 %TEMP%

```powershell
$src    = '<plugin-dir>\tools\client-smoke.mjs'
$client = '<plugin-dir>\client.js'
$tmp    = Join-Path $env:TEMP ('gate-' + [System.IO.Path]::GetRandomFileName().Replace('.',''))
New-Item -ItemType Directory $tmp | Out-Null
Copy-Item $src (Join-Path $tmp 'gate.mjs')
```

⚠️ 副本放进 `%TEMP%` 后，脚本里的 `DEFAULT_CLIENT = resolve(HERE, '..', 'client.js')` 会指向错地方，所以**必须**用 `--client <真 client.js>` 运行。

**先证明副本等价**：未注入的副本应当输出与原件**逐字一致**（`PASS 837 / SKIP 5 / FAIL 0`，exit 0）。不成立说明副本不忠实，后面所有结论都无效。

### 手法 ①：让**守恒闸门**红

注入位置：`runScenario` 里、`const notes = [];` 之后 —— 插一条**只在 `primitives-absent` 模式存在**的断言：

```js
if (!hasPrimitives) check('probe absent-only', true);
```

- **原理**：present 模式断言总数不变、absent 模式 +1 ⇒ `present.passes ≠ absent.passes + absent.skips`（这种模式差异正是真实世界里"运行期按模式分叉却没走检查"的形态）。
- **期望**：**exit 1**，且诊断是
  `不变式失败：出现了「既没通过、也没跳过」的静默丢失断言（两个模式断言总数必须相等）：` + 逐场景点名。
- **必看旁证**：那次运行的 `合计 … FAIL **0**`（全量跑时 `PASS` 甚至比正常**更多**）。
  ⇒ **这类缺陷对普通 PASS/FAIL 计数完全不可见**，只会让一个天真的读者以为"更绿了"。

### 手法 ②：让**下限闸门**红

注入位置同上，给 `check` 与 `checkP` **两个入口**加上同一个"消失预算"，让 N 条断言在**两个模式下对称地不计数**：

```js
const muteBudget = { left: 1 };                                          // 每个场景少 1 条
function check(...)  { if (muteBudget.left > 0) { muteBudget.left -= 1; return; } /* …原逻辑… */ }
function checkP(...) { if (muteBudget.left > 0) { muteBudget.left -= 1; return; } /* …原逻辑… */ }
```

- **原理**：两个模式**一起**变少 ⇒ 守恒不变式**仍然成立** ⇒ 只有"断言数下限"能发现。
- **期望**：**exit 1**，且诊断是
  `不变式失败：断言条数低于下限 —— 有断言凭空消失（既没通过也没跳过）：` + `- <场景>：present PASS n < 下限 m（断言疑似被删除）`。
- **必看旁证**：`present n === absent n + skips`（守恒**静默通过**）且 `FAIL 0`（PASS/FAIL 计数也看不见）。

### 团队标准：测"防虚高的闸门"必须过这两种表象

> **验证"防虚高的闸门"时，必须证明它在「PASS 数反而增加」和「FAIL 为 0」两种表象下仍能红** —— 因为这两者正是虚高的伪装。

只交"改了之后它红了 / 退出码非零"是**不够**的：必须同时交出**那次运行的 `PASS` / `FAIL` 计数**，说明它在计数器**看起来更绿**的时候依然会红。

### 团队标准：`ASSERTION_FLOOR` 必须等于当前基线，不得留松弛

> **`ASSERTION_FLOOR` 必须等于当前基线，不得留松弛。** 下限写高只会误报（安全）；**下限写低会静默削弱闸门**（危险）。因此新增/删除断言后**必须同步调整下限**，并在改动回报里给出"基线 present PASS ↔ 下限"的对照。
>
> **判据**：**若某场景注入 1 条消失后仍未被抓住 ⟺ 该下限写低了。**

形式化的等价说法：注入 1 条后**被抓住 ⟺ `基线 present PASS ≤ 下限`**。因为正常情况下 `基线 ≥ 下限`（否则本来就该报错），所以

- `下限 === 基线`（**零松弛**）⇒ 丢 1 条即被抓住 —— **灵敏，正确**；
- `下限 <  基线`（**有松弛**）⇒ 丢 `基线 − 下限` 条以内都不会响 —— **静默削弱闸门，危险**。

⇒ 所以"24 个下限全部精确等于基线"不是巧合，而是**这条标准的验收形态**。

### 一轮复核结果（采样，非硬结论）

- **手法 ①** → exit 1，**穷举点名 24/24 场景**；全量那次 `PASS 861`（= 837 + 24）、`FAIL 0`。守恒之外的另外两道闸门**未被触发**（说明注入只打中了守恒这一条）。
- **手法 ②**（每场景少 1 条，全量一次跑完）→ exit 1，`PASS 789`（= 837 − 24×2）、`FAIL 0`；守恒闸门与 present-SKIP 闸门**均未触发**；**24/24 场景全部被下限抓住**，`- <场景>：present PASS n < 下限 m` 明细 24 行齐全。
- **对照**：未注入的副本与原件的 sha256 一致（逐字节相同）、输出逐字一致（`PASS 837 / SKIP 5 / FAIL 0`，exit 0）—— 证明上面两次实验的对照是干净的。

<details>
<summary>手法 ② 的 24 行逐场景对照（基线 present PASS / 下限 / 注入后）—— 展开</summary>

> 「基线」列以**当次 `client-smoke` 输出**为准；本表仅记录**采集时刻**下的值（本次采集：`PASS 837 / SKIP 5 / FAIL 0`）。断言增删后这些数字会变，请以实际输出为准。

| 场景 | 基线 present PASS | 下限 | 注入后 | 被下限抓住 |
|---|---|---|---|---|
| attach | 17 | 17 | 16 | 是 |
| idleNone | 15 | 15 | 14 | 是 |
| statusLegacy | 17 | 17 | 16 | 是 |
| busyWithRunId | 18 | 18 | 17 | 是 |
| busyFallbackStatus | 18 | 18 | 17 | 是 |
| busyHopeless | 16 | 16 | 15 | 是 |
| parallelDefault | 15 | 15 | 14 | 是 |
| inflightCap | 14 | 14 | 13 | 是 |
| sseError | 17 | 17 | 16 | 是 |
| detailToggle | 17 | 17 | 16 | 是 |
| roundsHoles | 17 | 17 | 16 | 是 |
| dormant45 | 23 | 23 | 22 | 是 |
| countsanity | 14 | 14 | 13 | 是 |
| historyOk | 26 | 26 | 25 | 是 |
| historyStatsError | 16 | 16 | 15 | 是 |
| historyEmpty | 15 | 15 | 14 | 是 |
| historyUnready | 15 | 15 | 14 | 是 |
| historyRealFixture | 22 | 22 | 21 | 是 |
| historyCountScope | 16 | 16 | 15 | 是 |
| historyInterrupted | 21 | 21 | 20 | 是 |
| historyWriteFail | 18 | 18 | 17 | 是 |
| hostActiveRunDead | 19 | 19 | 18 | 是 |
| hostActiveRunAlive | 19 | 19 | 18 | 是 |
| regress | 16 | 16 | 15 | 是 |

**结论：24/24 全部被抓住；且全部 24 个下限都精确等于基线值 ⇒ 零松弛。**
这一点很重要 —— **下限写高只会误报（安全）；下限写低则会静默放过丢失的断言（危险）**。
因此本节的结果同时是"下限没有被写低"的证据。
（基线值会随断言增删而变：**新增断言后必须同步调高对应下限**；调低必须在回报里说明理由。场景数也会变 —— 本表是采集时刻的快照，不是该文件的常数。）
</details>

### 清理（双重确认后再删）

```powershell
$abs      = [System.IO.Path]::GetFullPath($tmp)
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
if ($abs.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and $abs -like (Join-Path $tempRoot 'gate-*')) {
  Remove-Item -LiteralPath $abs -Recurse -Force
}
```

验完**必须**复核被测原件哈希未变，并扫一遍插件目录有没有残留临时文件（`neg|pristine|floor|inject|\.bak|tmp`）。

---

## 文件与职责

**完整清单 —— 仓库里被 git 跟踪的全部 25 个文件**（`node_modules/` 与开发期诊断产物不在其中）：

| 职责 | 文件 |
|---|---|
| 清单 / 打包 / bundle 补丁 | `package.json` · `cordis.patch.yml` |
| 许可证 / 仓库属性 / 忽略规则 | `LICENSE` · `.gitattributes` · `.gitignore` |
| 宿主 HTTP 服务（`/fingerprint/*` 全部路由） | `lib/index.js` |
| 检测器封装（`lmfpd-sdk` 单例懒加载与状态） | `lib/detector.js` |
| 采样层（挑战 / 取样 / 有效性判定） | `lib/probe.js` |
| 聚合与排名（多轮 → 决策 / 排名 / 一致性） | `lib/aggregate.js` |
| 目标列举（provider / 模型 / 凭据可用性） | `lib/targets.js` |
| 流适配器（`ctx.llm.stream()` → `{text,endReason,firstByteMs}`） | `lib/send.js` |
| 运行历史存储（`%LOCALAPPDATA%\dsh-fingerprint\history.jsonl`） | `lib/history.js` |
| 页面 UI（浏览器半侧：侧栏入口 + 整页） | `client.js` |
| 静态装载自检 + 槽位/发布语义检查（四连 ① ②） | `tools/selfcheck.mjs` |
| 客户端运行时冒烟（四连 ③；内含两道防虚高闸门） | `tools/client-smoke.mjs` |
| 一次性真机驱动脚本（手动联调用） | `tools/live-probe.mjs` |
| 单元 / 集成测试（7 份，`node --test` 全量 157 条） | `test/aggregate.test.mjs` · `test/detector.test.mjs` · `test/history.test.mjs` · `test/index.test.mjs` · `test/probe.test.mjs` · `test/send.test.mjs` · `test/targets.test.mjs` |
| 设计文档 | `docs/DESIGN.md` |
| 文档 | `README.md` |

**计数**（逐项对齐 `git ls-files`）：`lib/` **7** + `test/` **7** + `tools/` **3** + `docs/` **1** + 根目录 **7**（`README.md` · `client.js` · `package.json` · `cordis.patch.yml` · `LICENSE` · `.gitignore` · `.gitattributes`）= **25** ✔

> 与 `git ls-files` 对齐（取权威清单的方式：`git -C <plugin-dir> ls-files`，等价于
> `gh api repos/Practice019/dsh-fingerprint/git/trees/main?recursive=1`）。
>
> ⚠️ **不在仓库里的两样东西**（所以**不要**在本表里找它们）：
> - `node_modules/` —— `.gitignore` 忽略，需要 `npm install` 自己装；
> - `.smoke.json` —— 开发期诊断产物，每次运行覆盖写，同样被忽略。**看到它存在于你的本地目录是正常的，但它不会被提交。**

> 若你 fork 后想动 `tools/` 下的东西：那三份文件职责完全不同（静态自检 / 运行时冒烟 / 一次性驱动），改之前先看清自己改的是哪一份。

发现别人文件里的缺陷 → **只回报，不代改**。（本仓库开发期就是这么协作的。）
