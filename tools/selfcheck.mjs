#!/usr/bin/env node
/**
 * dsh-fingerprint 装载自检（selfcheck）—— W4 产出物
 *
 * 职责：作为**独立裁判**校验 dsh-fingerprint 的"可装载性"。
 * 不实现任何插件功能，不修改任何被检查文件（纯只读），不重启 DSH。
 *
 * 用法：
 *   node tools/selfcheck.mjs
 *   node tools/selfcheck.mjs --json
 *   node tools/selfcheck.mjs --plugin <插件目录> --profile-dir <profile 目录>
 *
 * 退出码：有 FAIL → 1；否则（含只有 PASS/SKIP）→ 0。
 *
 * 检查项编号与 dsh-fingerprint-CONTRACT.md 的对应关系写在每项的标题里。
 * 契约 §1 = 身份常量；§2.1 = 客户端束硬约束；§8 = 通用约束。
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─────────────────────────── 契约常量（冻结） ───────────────────────────

/** 包名 / panellist id / main key（契约 §1） */
const PKG_NAME = 'dsh-fingerprint'
/** 版本（契约 §1，冻结值） */
const PKG_VERSION = '0.1.0'
/** cordis patch insert id（契约 §1） */
const INSERT_ID = 'fingerprint'

/**
 * 已知运行时版本 —— **采集时刻（2026-11-02）的实测值**，不是"永远成立"的常量。
 *
 * C7 用它判定 `engines.dsh` 是否覆盖当前运行时。
 * ⚠️ 与"本地开发期"的语义**相反**：本地开发时我们刻意**不声明** `engines.dsh`（避免不兼容时被静默 skip）；
 * 而**发布**必须声明它，否则使用者无从判断兼容性。C7 现在执行的是**发布**语义。
 * ⚠️ DSH 升级后此值必须同步更新，否则 C7 会给出错误结论。
 */
const RUNTIME_VERSION_AT_CAPTURE = '0.2.1-rc.3'
/** 采集日期 —— 与上面的常量配对；**只有回落到它时**才会在输出里标注，提示可能已过时。 */
const CAPTURE_DATE = '2026-11-02'
/** 发布要求的许可证标识（X5） */
const REQUIRED_LICENSE = 'MIT'
/** 侧栏 order（契约 §1，排在 Purge 的 30 之后） */
const SIDEBAR_ORDER = 40
/** 侧栏标签（契约 §1） */
const SIDEBAR_LABEL = '指纹检测'
/** 客户端 bundle 的 cordis 服务名（契约 §12.9：locale 必需，否则页面拿不到 t()） */
const EXPECTED_INJECT = ['slots', 'locale']
/** 回滚备件：profile 清单在装本插件前的快照（R1 用） */
const ROLLBACK_BACKUP_NAME = 'package.json.bak-fingerprint'

/** 客户端束只认这个导出键（契约 §2.2） */
const CLIENT_EXPORT_KEY = './client'
/** 宿主半侧根导出键 */
const ROOT_EXPORT_KEY = '.'

/**
 * 外壳种子词白名单：恰好 11 个（契约 §2.2）。
 * 只有这些模块名可以被 client.js 里的 require() 使用；
 * 其中 `@deepseek-ai/dsh-client-ui-slots` / `-ui-primitives` 磁盘上并不存在，
 * 它们是外壳在运行时注入的种子，不要试图安装。
 */
const SEED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

// ─────────────────────────── 路径与参数解析 ───────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * 解析命令行参数。
 * 默认插件目录 = 本脚本所在目录的上一级（即 <插件>/tools/.. = <插件>）。
 * 默认 profile 目录 = $DSH_HOME/profiles/desktop，$DSH_HOME 未设时用 ~/.dsh。
 */
function parseArgs(argv) {
  const options = {
    pluginDir: resolve(SCRIPT_DIR, '..'),
    profileDir: resolve(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop'),
    json: false,
    selftest: false,
    /** C7 判定对象的显式覆盖（最高优先级）。 */
    dshVersion: null,
    /** 额外指定一个 `@deepseek-ai/dsh/package.json` 路径（给非标准安装布局 / CI 用）。 */
    dshPkg: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--json') options.json = true
    else if (token === '--self-test') options.selftest = true
    else if (token === '--plugin' || token === '--profile-dir' || token === '--dsh-version' || token === '--dsh-pkg') {
      const value = argv[i += 1]
      if (typeof value !== 'string' || value.trim() === '') {
        process.stderr.write(`selfcheck: ${token} 缺少参数值\n`)
        process.exit(2)
      }
      if (token === '--plugin') options.pluginDir = resolve(value)
      else if (token === '--profile-dir') options.profileDir = resolve(value)
      else if (token === '--dsh-version') options.dshVersion = value.trim()
      else options.dshPkg = resolve(value)
    } else if (token === '--help' || token === '-h') {
      process.stdout.write(
        [
          '用法: node tools/selfcheck.mjs [选项]',
          '',
          '  --json                        汇总 JSON（含 pending 清单）',
          '  --self-test                   只跑夹具自测（证明各检查项能红能绿）',
          '  --plugin <插件目录>            默认 = 本脚本的上一级',
          '  --profile-dir <profile 目录>   默认 = $DSH_HOME/profiles/desktop',
          '  --dsh-version <ver>           C7 判定对象的显式覆盖（最高优先级；给 CI / 手动指定用）',
          '  --dsh-pkg <package.json 路径>  额外指定一个 @deepseek-ai/dsh/package.json',
          '                                （非标准安装布局；它会被排在动态候选表最前）',
          '  -h, --help                    显示本帮助',
          '',
          'C7 的判定对象（运行时 DSH 版本）按三级取值：--dsh-version > 动态读取 > 回落常量。',
          '输出里的「来源：…」会注明实际用了哪一路。',
          '',
        ].join('\n'),
      )
      process.exit(0)
    }
  }
  return options
}

const ARGS = parseArgs(process.argv.slice(2))
const PLUGIN_DIR = ARGS.pluginDir
const PROFILE_DIR = ARGS.profileDir
const PROFILE_MANIFEST = join(PROFILE_DIR, 'package.json')
/** profile 内该插件的 junction/symlink 位置 */
const LINK_PATH = join(PROFILE_DIR, 'node_modules', PKG_NAME)
/** C7 三级取值的结果（`--self-test` 只用夹具自带的 runtime，不读这里）。 */
const RUNTIME = resolveRuntimeVersion({ explicit: ARGS.dshVersion, extraPackagePath: ARGS.dshPkg })
const MANIFEST_TITLES = manifestTitles(RUNTIME.version)

// ─────────────────────────── 输出与结果收集 ───────────────────────────

const results = []
let failCount = 0
let skipCount = 0
let passCount = 0

/**
 * 记录并立即打印一项检查结果。
 * @param {string} id 检查编号，如 'C1'
 * @param {string} title 检查标题（含契约引用）
 * @param {'PASS'|'FAIL'|'SKIP'} status 结论
 * @param {string[]} evidence 证据行（原样打印，便于人工复核）
 */
function report(id, title, status, evidence = []) {
  if (status === 'FAIL') failCount += 1
  else if (status === 'SKIP') skipCount += 1
  else passCount += 1
  results.push({ id, title, status, evidence })
  if (ARGS.json) return
  process.stdout.write(`[${status}] ${id}  ${title}\n`)
  for (const line of evidence) process.stdout.write(`        ${line}\n`)
}

// ─────────────────────────── 通用只读工具 ───────────────────────────

/** 读取文本；失败返回 {ok:false, error}，绝不抛。 */
function readText(path) {
  try {
    return { ok: true, text: readFileSync(path, 'utf8') }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/** 读取并 JSON.parse；失败返回 {ok:false, error}。 */
function readJson(path) {
  const read = readText(path)
  if (!read.ok) return { ok: false, error: `读取失败: ${read.error}` }
  try {
    return { ok: true, value: JSON.parse(read.text) }
  } catch (error) {
    return { ok: false, error: `JSON.parse 失败: ${String(error.message)}` }
  }
}

/** 规范化路径后做大小写不敏感比较（Windows 语义）。 */
function samePath(left, right) {
  const norm = (value) => {
    let out = value
    try {
      out = realpathSync(value)
    } catch {
      /* 路径不存在时退回原字符串比较 */
    }
    return out.replace(/[\\/]+$/u, '').toLowerCase()
  }
  return norm(left) === norm(right)
}

/** 判断是不是"文件真实存在"（含符号链接指向存在目标）。 */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 把相对导出目标解析成绝对路径。 */
function resolveExportTarget(target) {
  if (typeof target !== 'string' || target.length === 0) return null
  if (/^[a-zA-Z]:[\\/]/u.test(target) || target.startsWith('/')) return target
  return resolve(PLUGIN_DIR, target)
}

/**
 * 从 package.json 的 exports 字段里取某个导出键的目标。
 * 支持：exports 直接是字符串（只代表根导出）、exports[key] 是字符串、exports[key] 是 {default:string}。
 * @returns {{present:boolean, target?:string|null, form?:string}}
 */
function exportEntry(exportsField, key) {
  if (exportsField === undefined || exportsField === null) return { present: false }
  if (typeof exportsField === 'string') {
    return key === ROOT_EXPORT_KEY
      ? { present: true, target: exportsField, form: 'string(exports 本身)' }
      : { present: false }
  }
  if (typeof exportsField !== 'object' || Array.isArray(exportsField)) return { present: false }
  const value = exportsField[key]
  if (value === undefined) return { present: false }
  if (typeof value === 'string') return { present: true, target: value, form: 'string' }
  if (value && typeof value === 'object' && typeof value.default === 'string') {
    return { present: true, target: value.default, form: '{default:string}' }
  }
  return { present: true, target: null, form: '不支持的形状（既不是 string 也不是 {default:string}）' }
}

/** 去掉 YAML 标量两端的引号与行尾注释。 */
function parseYamlScalar(raw) {
  const value = raw.trim()
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1)
    return end > 0 ? value.slice(1, end) : value.slice(1)
  }
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1)
    return end > 0 ? value.slice(1, end) : value.slice(1)
  }
  const comment = value.indexOf(' #')
  return comment >= 0 ? value.slice(0, comment).trim() : value
}

/**
 * 极简 YAML 扫描：收集所有 `- insert:` 块内的列表项，并抽出每项的 id / name。
 * 不引入 yaml 依赖（契约 §8：不引入新依赖），只处理本项目已知的 patch 形状。
 * @returns {Array<{id:string, name:string, line:number}>}
 */
function scanInsertItems(text) {
  const lines = text.split(/\r?\n/u)
  const items = []
  let index = 0
  while (index < lines.length) {
    const header = /^(\s*)-\s*insert:\s*$/u.exec(lines[index])
    if (header === null) {
      index += 1
      continue
    }
    const insertIndent = header[1].length
    const block = []
    index += 1
    // 收集比 `- insert:` 缩进更深的所有行，直到回到同级或更浅
    while (index < lines.length) {
      const raw = lines[index]
      if (raw.trim() === '') {
        block.push(raw)
        index += 1
        continue
      }
      const indent = /^(\s*)/u.exec(raw)[1].length
      if (indent <= insertIndent && !/^\s*#/u.test(raw)) break
      if (indent <= insertIndent && /^\s*#/u.test(raw)) {
        // 同级注释仍算块外的分隔，但为了容错继续收集
        block.push(raw)
        index += 1
        continue
      }
      block.push(raw)
      index += 1
    }
    // 找到列表项的缩进（块内 `- ` 的最浅缩进）
    let itemIndent = null
    for (const raw of block) {
      const match = /^(\s*)-\s/u.exec(raw)
      if (match === null) continue
      // 跳过更深层的嵌套列表（例如 insert 项内的 config 列表）
      if (itemIndent === null || match[1].length < itemIndent) itemIndent = match[1].length
    }
    if (itemIndent === null) continue
    // 按 itemIndent 切分列表项
    let current = null
    let currentLine = 0
    for (let cursor = 0; cursor < block.length; cursor += 1) {
      const raw = block[cursor]
      const match = new RegExp(`^(\\s{${itemIndent}})-\\s`, 'u').exec(raw)
      if (match !== null) {
        if (current !== null) items.push({ ...current, line: currentLine })
        current = { id: '', name: '' }
        currentLine = index - block.length + cursor + 1
        const rest = raw.slice(match[0].length)
        const inline = /^(id|name):\s*(.*)$/u.exec(rest.trim())
        if (inline !== null) current[inline[1]] = parseYamlScalar(inline[2])
        continue
      }
      if (current === null) continue
      const field = /^\s*(id|name):\s*(.*)$/u.exec(raw)
      if (field !== null && current[field[1]] === '') current[field[1]] = parseYamlScalar(field[2])
    }
    if (current !== null) items.push({ ...current, line: currentLine })
  }
  return items
}

/**
 * 剥离注释，只保留"代码视图"，用于标记类检查。
 *
 * 为什么必须这么做：注释里出现 `window.__ModuleLoader__.load(` / `export function apply`
 * 这类字样时，直接对原文做 includes 会**假 PASS**。裁判宁可严格。
 * 字符串字面量原样保留（模板串的 ${} 亦然），因此字符串里的 require(...) 仍会被计入。
 * 已知局限：正则字面量里的 `//` 可能被误判为行注释（本插件代码不涉及）。
 * @param {string} text 原始文本
 * @returns {string} 注释被空白替代后的文本（保留换行，便于定位行号）
 */
function stripComments(text) {
  let out = ''
  let state = 'code'
  let index = 0
  while (index < text.length) {
    const ch = text[index]
    const next = text[index + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line'
        index += 2
        continue
      }
      if (ch === '/' && next === '*') {
        state = 'block'
        index += 2
        continue
      }
      if (ch === "'") state = 'sq'
      else if (ch === '"') state = 'dq'
      else if (ch === '`') state = 'tpl'
      out += ch
      index += 1
      continue
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code'
        out += ch
      }
      index += 1
      continue
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code'
        index += 2
        continue
      }
      if (ch === '\n') out += ch
      index += 1
      continue
    }
    // 字符串状态：原样保留
    if (ch === '\\') {
      out += ch + (next ?? '')
      index += 2
      continue
    }
    if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) {
      state = 'code'
    }
    out += ch
    index += 1
  }
  return out
}

/** 收集文本里所有 `require("...")` / `require('...')` 的实参。 */
function collectRequireLiterals(text) {
  const literals = []
  const pattern = /require\s*\(\s*(['"])([^'"]*)\1\s*\)/gu
  let match
  while ((match = pattern.exec(text)) !== null) literals.push(match[2])
  return literals
}

/**
 * 找出非字面量的 require( 调用（反引号或标识符），这些无法静态校验。
 *
 * 保守偏向：宁可在字符串里出现 "require(xxx)" 之类文本时误报，也不漏掉真正的动态 require。
 * 契约 §2.2 只允许 11 个种子词的**字面** require，所以误报的代价只是一次人工确认。
 * @param {string} text 代码视图文本
 * @returns {string[]} 非字面量 require 的实参片段
 */
function collectRequireDynamic(text) {
  const found = []
  const pattern = /require\s*\(\s*([^\s'"()][^()]*)/gu
  let match
  while ((match = pattern.exec(text)) !== null) found.push(match[1].trim().slice(0, 60))
  return found
}

// ─────────────────── 槽位语义抽取工具（S1–S6 用） ───────────────────
// 目标：从 client.js 的**代码视图**里抽出槽位注册字面量，再与契约 §1 / §2.1 / §12.9 比对。
// 注意：注册里大量使用标识符引用（id: PANEL_ID、order: SIDEBAR_ORDER），
// 所以必须先做一层"文件级简单常量绑定"解析，否则会误判为抽取失败。

/** 解析标量字面量（字符串 / 数字 / 布尔）；不是字面量则返回 null。 */
function resolveScalarLiteral(raw) {
  const value = String(raw ?? '').trim()
  let match = /^"([^"\\]*(?:\\.[^"\\]*)*)"$/u.exec(value)
  if (match !== null) return { kind: 'string', value: match[1] }
  match = /^'([^'\\]*(?:\\.[^'\\]*)*)'$/u.exec(value)
  if (match !== null) return { kind: 'string', value: match[1] }
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return { kind: 'number', value: Number(value) }
  if (value === 'true' || value === 'false') return { kind: 'boolean', value: value === 'true' }
  return null
}

/** 从数组字面量文本里抽出全部字符串元素（保持顺序）。 */
function parseStringArray(raw) {
  const out = []
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/gu
  let match
  while ((match = re.exec(String(raw ?? ''))) !== null) out.push(match[1] ?? match[2])
  return out
}

/**
 * 收集文件级简单常量绑定：标量字面量与字符串数组字面量。
 * 只处理 `const X = <字面量>;` 这一形态，够用且不会误伤复杂表达式。
 */
function collectConsts(codeText) {
  const map = new Map()
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(\[(?:[^\]\\]|\\.)*\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false)\s*[;,]/gu
  let match
  while ((match = re.exec(codeText)) !== null) {
    const name = match[1]
    if (map.has(name)) continue
    const raw = match[2]
    if (raw.startsWith('[')) map.set(name, { kind: 'array', value: parseStringArray(raw), raw })
    else {
      const scalar = resolveScalarLiteral(raw)
      if (scalar !== null) map.set(name, { ...scalar, raw })
    }
  }
  return map
}

/**
 * 从一个值起点读到"顶层逗号或闭合符"之前的原始文本（括号/方括号/花括号计深，字符串跳过）。
 */
function readPropertyValue(text, start) {
  let depth = 0
  let index = start
  let state = 'code'
  while (index < text.length) {
    const ch = text[index]
    const next = text[index + 1]
    if (state === 'code') {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break
        depth -= 1
      } else if (ch === ',' && depth === 0) break
      else if (ch === "'") state = 'sq'
      else if (ch === '"') state = 'dq'
      else if (ch === '`') state = 'tpl'
    } else if (ch === '\\') {
      index += 2
      continue
    } else if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) {
      state = 'code'
    }
    index += 1
  }
  return text.slice(start, index)
}

/** 抽出对象字面量里**顶层**的 `key: value` 对（值整段跳过，所以不会误收嵌套键）。 */
function extractFlatProperties(text) {
  const props = new Map()
  const keyRe = /([A-Za-z_$][\w$]*)\s*:/gu
  let index = 0
  while (index < text.length) {
    keyRe.lastIndex = index
    const match = keyRe.exec(text)
    if (match === null) break
    const valueStart = match.index + match[0].length
    const raw = readPropertyValue(text, valueStart).trim()
    if (!props.has(match[1])) props.set(match[1], raw)
    index = valueStart + raw.length + 1
  }
  return props
}

/**
 * 通用括号配对切片：取 openIndex 处定界符之后、与之配对的那个定界符之前的内容（字符串感知）。
 * 默认按圆括号工作；花括号用于抽对象体。
 */
function sliceBalanced(text, openIndex, open = '(', close = ')') {
  if (text[openIndex] !== open) return null
  let depth = 0
  let index = openIndex
  let state = 'code'
  while (index < text.length) {
    const ch = text[index]
    if (state === 'code') {
      if (ch === open) depth += 1
      else if (ch === close) {
        depth -= 1
        if (depth === 0) return text.slice(openIndex + 1, index)
      } else if (ch === "'") state = 'sq'
      else if (ch === '"') state = 'dq'
      else if (ch === '`') state = 'tpl'
    } else if (ch === '\\') {
      index += 2
      continue
    } else if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) {
      state = 'code'
    }
    index += 1
  }
  return null
}

/** 转义正则元字符（标识符一般不需要，但保持严谨）。 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 找 `const|let|var <name> = {` 的对象体（不含最外层花括号）。 */
function findObjectBody(codeText, name) {
  const pattern = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=\\s*\\{`, 'u')
  const match = pattern.exec(codeText)
  if (match === null) return null
  return sliceBalanced(codeText, match.index + match[0].length - 1, '{', '}')
}

/** 找 `function <name>(...) {` 的函数体（不含最外层花括号）。 */
function findFunctionBody(codeText, name) {
  const pattern = new RegExp(`function\\s+${escapeRegExp(name)}\\s*\\(`, 'u')
  const match = pattern.exec(codeText)
  if (match === null) return null
  const paramsOpen = match.index + match[0].length - 1
  const params = sliceBalanced(codeText, paramsOpen, '(', ')')
  if (params === null) return null
  const braceIndex = codeText.indexOf('{', paramsOpen + params.length + 2)
  if (braceIndex < 0) return null
  return sliceBalanced(codeText, braceIndex, '{', '}')
}

/**
 * 把"字典表达式"解析成对象体，支持多跳（真实代码里三种都用上了）：
 *   `ZH`（标识符）        → `const ZH = {...}`
 *   `enTable()`（无参调用）→ `function enTable(){ return EN; }` → 递归解析 `EN`
 *   `{...}`（内联字面量）  → 直接去壳
 * 跳数上限 5，防环。
 * @returns {string|null} 对象体文本；解析不出返回 null
 */
function resolveDictionaryBody(codeText, expr, hop = 0) {
  if (hop > 5) return null
  const value = String(expr ?? '').trim()
  if (value === '') return null
  // 内联对象字面量：readPropertyValue 已保证它是配平的整段
  if (value.startsWith('{')) return sliceBalanced(value, 0, '{', '}')
  // 无参函数调用：ident()
  const callMatch = /^([A-Za-z_$][\w$]*)\s*\(\s*\)$/u.exec(value)
  if (callMatch !== null) {
    const fnBody = findFunctionBody(codeText, callMatch[1])
    if (fnBody === null) return null
    const returned = /\breturn\s+([^;]+);/u.exec(fnBody)
    if (returned === null) return null
    return resolveDictionaryBody(codeText, returned[1], hop + 1)
  }
  // 纯标识符
  if (/^[A-Za-z_$][\w$]*$/u.test(value)) {
    const objectBody = findObjectBody(codeText, value)
    if (objectBody !== null) return objectBody
    const fnBody = findFunctionBody(codeText, value)
    if (fnBody === null) return null
    const returned = /\breturn\s+([^;]+);/u.exec(fnBody)
    if (returned === null) return null
    return resolveDictionaryBody(codeText, returned[1], hop + 1)
  }
  return null
}

/**
 * 从 `locale.register(<NS>, { zh: ZH, en: enTable() })` 取出 zh / en 两份字典的键表。
 *
 * 覆盖三种真实写法：
 *   ① 冒号属性      `{ zh: ZH, en: enTable() }`          （本插件 client.js 的写法）
 *   ② ES6 简写      `{ zh, en }`                        （dsh-skill-mcp-panel 的写法）
 *   ③ 内联对象      `{ zh: { nav: "..." }, en: {...} }`
 * 并且当同一个文件里有多个 `locale.register` 时，**优先选命名空间与 panellist 的 `locale` 一致的那个**
 * （一个文件注册多套字典是常见的，选错会核对到别的表）。
 * 找不到 register 调用时，退回按 `const ZH = {...}` / `const EN = {...}` 约定查找。
 * @param {string} codeText 代码视图
 * @param {string|undefined} preferNamespace panellist 注册里 `locale:` 的原始表达式（通常是 `NS`）
 * @returns {{how:string, zh:Map|null, en:Map|null}}
 */
function locateLocaleTables(codeText, preferNamespace) {
  const calls = []
  const re = /locale\s*\.\s*register\s*\(/gu
  let match
  while ((match = re.exec(codeText)) !== null) {
    const openIndex = match.index + match[0].length - 1
    calls.push({
      line: codeText.slice(0, match.index).split('\n').length,
      body: sliceBalanced(codeText, openIndex),
    })
  }

  if (calls.length === 0) {
    return {
      how: '未找到 locale.register(...)，退回按 `const ZH = {...}` / `const EN = {...}` 约定查找',
      zh: findObjectBody(codeText, 'ZH') === null ? null : extractFlatProperties(findObjectBody(codeText, 'ZH')),
      en: findObjectBody(codeText, 'EN') === null ? null : extractFlatProperties(findObjectBody(codeText, 'EN')),
    }
  }

  // 选调用：优先第一个实参等于 panellist 的 locale 表达式
  let chosen = calls[0]
  let howPick = `文件内 ${calls.length} 处 locale.register，取首个 @L${calls[0].line}`
  if (preferNamespace !== undefined && preferNamespace !== null && preferNamespace !== '') {
    const hit = calls.find((item) => item.body !== null && readPropertyValue(item.body, 0).trim() === preferNamespace)
    if (hit !== undefined) {
      chosen = hit
      howPick = `文件内 ${calls.length} 处 locale.register，按 panellist 的 locale=${JSON.stringify(preferNamespace)} 选中 @L${hit.line}`
    } else {
      howPick = `文件内 ${calls.length} 处 locale.register，没有实参等于 ${JSON.stringify(preferNamespace)} 的，退回首个 @L${calls[0].line}`
    }
  }

  if (chosen.body === null) {
    return { how: `locale.register(...) @L${chosen.line} 括号不配对`, zh: null, en: null }
  }

  const props = extractFlatProperties(chosen.body)
  /** 冒号属性优先；否则探测 ES6 简写（属性名即标识符）。 */
  const expressionFor = (name) => {
    const direct = props.get(name)
    if (direct !== undefined) return { expr: direct, style: '冒号属性' }
    const shorthand = new RegExp(`(?:^|[{,\\s])${escapeRegExp(name)}(?=[\\s,}])`, 'u')
    return shorthand.test(chosen.body) ? { expr: name, style: 'ES6 简写' } : null
  }

  const zhPick = expressionFor('zh')
  const enPick = expressionFor('en')
  const zhBody = zhPick === null ? null : resolveDictionaryBody(codeText, zhPick.expr)
  const enBody = enPick === null ? null : resolveDictionaryBody(codeText, enPick.expr)

  return {
    how: `${howPick}；zh=${JSON.stringify(zhPick === null ? null : zhPick.expr)}(${zhPick === null ? '未找到' : zhPick.style}) en=${JSON.stringify(enPick === null ? null : enPick.expr)}(${enPick === null ? '未找到' : enPick.style})`,
    zh: zhBody === null ? null : extractFlatProperties(zhBody),
    en: enBody === null ? null : extractFlatProperties(enBody),
  }
}

/** 把一个属性原始值解析成 {kind, value}；标识符会去常量表里查一层。 */
function resolveSlotValue(raw, consts) {
  const value = String(raw ?? '').trim()
  const literal = resolveScalarLiteral(value)
  if (literal !== null) return { ...literal, raw: value }
  if (/^[A-Za-z_$][\w$]*$/u.test(value)) {
    const bound = consts.get(value)
    if (bound !== undefined) return { kind: bound.kind, value: bound.value, raw: value, via: value }
    return { kind: 'unresolved-identifier', value: null, raw: value }
  }
  if (/^(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/u.test(value) || /^function\b/u.test(value)) {
    return { kind: 'thunk', value: null, raw: value }
  }
  if (value.startsWith('[')) return { kind: 'array', value: parseStringArray(value), raw: value }
  return { kind: 'other', value: null, raw: value }
}

/** 找全部 `slots.register(<对象>, ...)` 调用，返回行号 + 顶层属性表。 */
function findSlotRegistrations(codeText) {
  const found = []
  const re = /slots\.register\s*\(/gu
  let match
  while ((match = re.exec(codeText)) !== null) {
    const openIndex = match.index + match[0].length - 1
    const body = sliceBalanced(codeText, openIndex)
    if (body === null) continue
    found.push({
      line: codeText.slice(0, match.index).split('\n').length,
      body,
      props: extractFlatProperties(body),
    })
  }
  return found
}

/** 把 `exports.inject = X` 的 X 解析成字符串数组；解析不出返回 null。 */
function resolveSlotInjectArray(codeText, consts) {
  const match = /(?:[A-Za-z_$][\w$]*\.)?exports\.inject\s*=\s*([^;\n]+)/u.exec(codeText)
  if (match === null) return { found: false, value: null, raw: null }
  const raw = match[1].trim()
  if (raw.startsWith('[')) return { found: true, value: parseStringArray(raw), raw }
  if (/^[A-Za-z_$][\w$]*$/u.test(raw)) {
    const bound = consts.get(raw)
    if (bound !== undefined && bound.kind === 'array') return { found: true, value: bound.value, raw, via: raw }
    return { found: true, value: null, raw, via: raw }
  }
  return { found: true, value: null, raw }
}

// ─────────────── 槽位判定（S1–S7 的唯一实现，主流程与 --self-test 共用） ───────────────
const SLOT_TITLES = {
  S1: 'sidebar.panellist 注册的 id === "dsh-fingerprint"（契约 §1）',
  S2: 'main 注册的 key === sidebar.panellist 注册的 id（契约 §2.1 一致性）',
  S3: 'sidebar.panellist 注册的 order === 40（契约 §1）',
  S4: 'sidebar.panellist 注册的 label 存在且为 thunk 或字符串（契约 §2.1）',
  S5: "module.exports.inject === ['slots','locale']（契约 §12.9）",
  S6: '页面注册在 slots.register 的 name: "main" 上（契约 §2.1）',
  S7: `label 的实际中文值 === ${JSON.stringify(SIDEBAR_LABEL)}（thunk 追到 ZH 字典；契约 §1）`,
}

/**
 * 对一段**代码视图**文本判定 S1–S7。
 * 抽成纯函数的原因：主流程和 `--self-test` 必须共用同一份判定逻辑，否则自测会与真实检查漂移。
 * 抽取失败一律 FAIL（不得 SKIP）—— 抽不出来就说明注册写错了。
 * @param {string} codeText 已剥离注释的代码文本
 * @returns {{entries: Array<{id:string,title:string,status:string,evidence:string[]}>, shared: {constNote:string,regNote:string}}}
 */
function judgeSlots(codeText) {
  const consts = collectConsts(codeText)
  const regs = findSlotRegistrations(codeText)

  // 只展示"本组检查真正引用到的"常量绑定，避免把文件里的无关局部变量刷屏。
  const rawValues = []
  for (const reg of regs) {
    for (const key of ['name', 'id', 'key', 'order', 'label', 'locale', 'inject']) {
      const raw = reg.props.get(key)
      if (raw !== undefined) rawValues.push(raw)
    }
  }
  const injectAssignMatch = /(?:[A-Za-z_$][\w$]*\.)?exports\.inject\s*=\s*([^;\n]+)/u.exec(codeText)
  if (injectAssignMatch !== null) rawValues.push(injectAssignMatch[1])
  const referenced = new Set()
  for (const raw of rawValues) {
    for (const token of String(raw).matchAll(/[A-Za-z_$][\w$]*/gu)) referenced.add(token[0])
  }
  const relevantConsts = [...consts.entries()].filter(([name]) => referenced.has(name))
  const constNote = relevantConsts.length === 0
    ? '本项引用到的常量绑定: 0 个'
    : `本项引用到的常量绑定 ${relevantConsts.length} 个: ${relevantConsts.map(([key, item]) => `${key}=${JSON.stringify(item.value)}`).join(', ')}（文件级共 ${consts.size} 个）`
  const regNote = regs.length === 0
    ? 'slots.register 调用: 0 处'
    : `slots.register 调用 ${regs.length} 处: ${regs.map((reg) => `@L${reg.line}`).join(', ')}`

  const pickSlot = (slotName) =>
    regs.find((reg) => resolveSlotValue(reg.props.get('name'), consts).value === slotName) ?? undefined
  const show = (resolved) => resolved === undefined
    ? '(缺失)'
    : `${resolved.kind}=${JSON.stringify(resolved.value)}${resolved.via === undefined ? '' : ` (来自 ${resolved.via})`} raw=${JSON.stringify(resolved.raw)}`

  const panel = pickSlot('sidebar.panellist')
  const mainReg = pickSlot('main')
  const panelId = panel === undefined ? undefined : resolveSlotValue(panel.props.get('id'), consts)
  const mainKey = mainReg === undefined ? undefined : resolveSlotValue(mainReg.props.get('key'), consts)

  const entries = []
  const add = (id, status, evidence) => entries.push({ id, title: SLOT_TITLES[id], status, evidence })

  // S1：panellist id === 冻结包名
  if (panel === undefined || panel.props.get('id') === undefined) {
    add('S1', 'FAIL', ['抽取失败：找不到 `name: "sidebar.panellist"` 的 slots.register，或该注册没有 id 字段。'])
  } else if (panelId.kind !== 'string') {
    add('S1', 'FAIL', [`@L${panel.line} id = ${show(panelId)} —— 需要能解析成字符串字面量（或指向字符串字面量的文件级常量）。`])
  } else {
    add('S1', panelId.value === PKG_NAME ? 'PASS' : 'FAIL', [
      `@L${panel.line} id = ${show(panelId)}；契约 §1 冻结值 ${JSON.stringify(PKG_NAME)}`,
    ])
  }

  // S2：main.key 必须等于 panellist.id（最容易错的一致性）
  if (panelId === undefined || panelId.kind !== 'string') {
    add('S2', 'FAIL', ['无法确定 panellist 的 id（见 S1），一致性无法核对。'])
  } else if (mainReg === undefined || mainReg.props.get('key') === undefined) {
    add('S2', 'FAIL', ['抽取失败：找不到 `name: "main"` 的 slots.register，或该注册没有 key 字段。'])
  } else if (mainKey.kind !== 'string') {
    add('S2', 'FAIL', [`@L${mainReg.line} key = ${show(mainKey)} —— 需要能解析成字符串字面量。`])
  } else {
    add('S2', mainKey.value === panelId.value ? 'PASS' : 'FAIL', [
      `panellist.id (@L${panel.line}) = ${JSON.stringify(panelId.value)}`,
      `main.key    (@L${mainReg.line}) = ${JSON.stringify(mainKey.value)}`,
      mainKey.value === panelId.value
        ? '两者一致 ✔（否则点行会抛 main panel "<id>" is not registered）'
        : '两者不一致 ✘ —— 点行必然抛未注册。',
    ])
  }

  // S3：order === 40
  const order = panel === undefined ? undefined : resolveSlotValue(panel.props.get('order'), consts)
  if (panel === undefined || order === undefined) {
    add('S3', 'FAIL', ['抽取失败：找不到 panellist 注册，或该注册没有 order 字段。'])
  } else if (order.kind !== 'number') {
    add('S3', 'FAIL', [`@L${panel.line} order = ${show(order)} —— 需要解析成数字。`])
  } else {
    add('S3', order.value === SIDEBAR_ORDER ? 'PASS' : 'FAIL', [
      `@L${panel.line} order = ${show(order)}；契约 §1 冻结值 ${SIDEBAR_ORDER}（排在 Purge 的 30 之后）`,
    ])
  }

  // S4：label 存在且形式为 thunk 或字符串
  const label = panel === undefined ? undefined : resolveSlotValue(panel.props.get('label'), consts)
  if (panel === undefined || label === undefined) {
    add('S4', 'FAIL', ['抽取失败：找不到 panellist 注册，或该注册没有 label 字段。'])
  } else if (label.kind !== 'thunk' && label.kind !== 'string') {
    add('S4', 'FAIL', [`@L${panel.line} label = ${show(label)} —— 契约 §2.1 只接受 string 或 () => string。`])
  } else {
    add('S4', 'PASS', [
      `@L${panel.line} label = ${show(label)}`,
      label.kind === 'string'
        ? '[info] 是字符串字面量（契约 §2.1 允许 string）；它的**值**由 S7 比对。'
        : '[info] 是 thunk（语言切换时由宿主重新投影），符合契约 §2.1；它的**实际中文值**由 S7 追到 ZH 字典比对。',
    ])
  }

  // S5：module.exports.inject === ['slots','locale']
  const inject = resolveSlotInjectArray(codeText, consts)
  if (!inject.found) {
    add('S5', 'FAIL', ['抽取失败：找不到 `exports.inject = ...` 赋值。'])
  } else if (inject.value === null) {
    add('S5', 'FAIL', [`exports.inject = ${inject.raw}${inject.via === undefined ? '' : ` (标识符 ${inject.via})`} —— 解析不出字符串数组。`])
  } else {
    const ok = inject.value.length === EXPECTED_INJECT.length
      && inject.value.every((item, index) => item === EXPECTED_INJECT[index])
    add('S5', ok ? 'PASS' : 'FAIL', [
      `exports.inject = [${inject.value.map((item) => JSON.stringify(item)).join(', ')}]${inject.via === undefined ? '' : ` (来自 ${inject.via})`}`,
      `契约 §12.9 冻结值 = [${EXPECTED_INJECT.map((item) => JSON.stringify(item)).join(', ')}]`,
      ok ? '完全一致 ✔（locale 必需：main 注册带 locale: NS，宿主在 entry 带 locale 时才注入 t()）' : '不一致 ✘。',
    ])
  }

  // S6：页面注册在 name: "main" 上
  if (mainReg === undefined) {
    add('S6', 'FAIL', ['抽取失败：找不到任何 `name: "main"` 的 slots.register 调用。'])
  } else {
    add('S6', 'PASS', [
      `命中 @L${mainReg.line}，该注册的顶层字段: ${[...mainReg.props.keys()].join(', ')}`,
      '[note] 与 S2 刻意分工：S6 只判"存在 name: main 的注册"，S2 判"key 与 panellist.id 是否一致"。',
    ])
  }

  // S7：label 的**实际中文值** === 契约 §1 冻结标签（thunk 要追到 ZH 字典）
  // S4 只判形式；"值"这件事必须单独追，否则 label 写成别的字串也无人发现。
  {
    if (panel === undefined || label === undefined) {
      add('S7', 'FAIL', ['抽取失败：找不到 panellist 注册，或该注册没有 label 字段（见 S4）。'])
    } else if (label.kind === 'string') {
      const ok = label.value === SIDEBAR_LABEL
      add('S7', ok ? 'PASS' : 'FAIL', [
        `label 是字符串字面量，直接比对：实际 ${JSON.stringify(label.value)}`,
        `契约 §1 冻结值 ${JSON.stringify(SIDEBAR_LABEL)} → ${ok ? '一致 ✔' : '不一致 ✘'}`,
        '[note] 走的是 string 分支，不查字典（无字典键可追）。',
      ])
    } else if (label.kind !== 'thunk') {
      add('S7', 'FAIL', [`label 形式不合法（kind=${label.kind}，见 S4），无法追值。`])
    } else {
      const keyMatch = /\b[A-Za-z_$][\w$]*\(\s*["']([^"']+)["']\s*\)/u.exec(label.raw)
      if (keyMatch === null) {
        add('S7', 'FAIL', [
          `label 是 thunk 但里面找不到「函数调用 + 字符串键」形态，抽不出字典键：raw=${JSON.stringify(label.raw)}`,
          '契约 §1 要求侧栏标签为「指纹检测」，因此这个值必须可静态核对。',
        ])
      } else {
        const key = keyMatch[1]
    const tables = locateLocaleTables(codeText, panel.props.get('locale'))
        const chain = [
          `追值链: label thunk raw=${JSON.stringify(label.raw)} → 字典键 ${JSON.stringify(key)}`,
          `字典定位: ${tables.how}`,
        ]
        if (tables.zh === null) {
          add('S7', 'FAIL', [...chain, 'zh 字典未取到（locale.register 的 zh 表达式解析不出对象）—— 无法核对中文标签值。'])
        } else if (!tables.zh.has(key)) {
          add('S7', 'FAIL', [
            ...chain,
            `zh 字典里没有 ${JSON.stringify(key)} 键。键集前 8 个: ${[...tables.zh.keys()].slice(0, 8).map((item) => JSON.stringify(item)).join(', ')}`,
          ])
        } else {
          const zhRaw = tables.zh.get(key)
          const scalar = resolveScalarLiteral(zhRaw)
          const value = scalar === null ? null : scalar.value
          const valueOk = value === SIDEBAR_LABEL
          const enHasKey = tables.en !== null && tables.en.has(key)
          chain.push(
            `zh.${key} = ${JSON.stringify(value)}${scalar === null ? `（raw=${JSON.stringify(zhRaw)} 不是标量字面量）` : ''}；契约 §1 冻结值 ${JSON.stringify(SIDEBAR_LABEL)} → ${valueOk ? '一致 ✔' : '不一致 ✘'}`,
          )
          if (tables.en === null) {
            chain.push('[FAIL 依据] en 字典未取到（enTable() / EN 解析不出对象）。')
          } else {
            chain.push(
              enHasKey
                ? `en.${key} 键存在 ✔（只核对键存在性，不校验英文值）`
                : `en.${key} 键缺失 ✘ —— 源码注释声明「en 对齐键集」，缺键会让英文环境回退到键名。`,
            )
          }
          add('S7', valueOk && enHasKey ? 'PASS' : 'FAIL', chain)
        }
      }
    }
  }

  return { entries, shared: { constNote, regNote } }
}

// ─────────────── 夹具自测（--self-test）：证明 S1–S6 六项都能红 ───────────────
//
// 为什么需要它：反例验伪（拿已装的 dsh-skill-mcp-panel 跑）只能证明 S1/S3/S5 能红 ——
// 那个插件在 S2（key 与 id 恰好一致）、S4（label 形式合法）、S6（有 main 注册）上本来就合规，
// 所以那三项在它身上是 PASS。要证明六项都不是死代码，只能自己造"应红"的输入。
// 夹具走的是**同一份** judgeSlots()，因此这里的结论能代表真实检查的行为。

/** 用固定模板拼一份合成 client.js 源码；overrides 用来注入某一种缺陷。 */
function slotFixtureSource(overrides = {}) {
  const {
    panellistId = 'PANEL_ID',
    mainKey = 'PANEL_ID',
    order = 'SIDEBAR_ORDER',
    label = '() => t("nav")',
    injectRhs = 'inject',
    includePanellist = true,
    includeMain = true,
    includeLocaleRegister = true,
    zhNav = '指纹检测',
    includeEnNav = true,
    /** 'colon' = `{ zh: ZH, en: enTable() }`（本插件的写法）；'shorthand' = `{ zh, en }`（dsh-skill-mcp-panel 的写法） */
    registerStyle = 'colon',
    /** 在正确的那条 locale.register 之前插入一条"别的命名空间的字典"，用于验证命名空间选择逻辑 */
    extraRegisterFirst = false,
    panellistLocale = 'NS',
    bindings = 'const PANEL_ID = "dsh-fingerprint";\nconst NS = "dsh-fingerprint";\nconst OTHER_NS = "other-ns";\nconst SIDEBAR_ORDER = 40;\nconst inject = ["slots", "locale"];',
  } = overrides
  const navLine = (value) => `  nav: ${JSON.stringify(value)},`
  const dictBindings = registerStyle === 'shorthand'
    ? [
      'const zh = {',
      navLine(zhNav),
      '  title: "LM Fingerprint Detection",',
      '};',
      'const en = {',
      includeEnNav ? navLine('Fingerprint') : '  title: "LM Fingerprint Detection",',
      '};',
    ]
    : [
      'const ZH = {',
      navLine(zhNav),
      '  title: "LM Fingerprint Detection",',
      '};',
      'const EN = {',
      includeEnNav ? navLine('Fingerprint') : '  title: "LM Fingerprint Detection",',
      '};',
      'function enTable() {',
      '  return EN;',
      '}',
    ]
  const registerLine = registerStyle === 'shorthand'
    ? '  ctx.effect(() => locale.register(NS, { zh, en }));'
    : '  ctx.effect(() => locale.register(NS, { zh: ZH, en: enTable() }));'
  return [
    bindings,
    ...dictBindings,
    'function apply(ctx) {',
    includeLocaleRegister && extraRegisterFirst
      ? '  ctx.effect(() => locale.register(OTHER_NS, { zh: { nav: "别的标签" }, en: { nav: "Other" } }));'
      : '',
    includeLocaleRegister ? registerLine : '',
    includePanellist
      ? `  ctx.slots.register({ name: "sidebar.panellist", id: ${panellistId}, order: ${order}, label: ${label}, locale: ${panellistLocale} }, FingerprintIcon);`
      : '',
    includeMain
      ? `  ctx.slots.register({ name: "main", key: ${mainKey}, locale: NS, inject: () => ({}) }, FingerprintPage);`
      : '',
    '}',
    `bundleModule.exports.inject = ${injectRhs};`,
  ].filter((line) => line !== '').join('\n')
}

/** 每个夹具：名字 + 期望状态（未列出的项默认 PASS）。 */
const SLOT_FIXTURES = [
  { name: '基准（无缺陷）', overrides: {}, expect: {} },
  { name: 'panellist id 写错', overrides: { panellistId: '"wrong-id"' }, expect: { S1: 'FAIL', S2: 'FAIL' } },
  { name: 'main.key 与 panellist.id 不一致', overrides: { mainKey: '"other-panel"' }, expect: { S2: 'FAIL' } },
  { name: 'order 写错（30 而不是 40）', overrides: { order: '30' }, expect: { S3: 'FAIL' } },
  { name: 'label 形式非法（数字）', overrides: { label: '42' }, expect: { S4: 'FAIL', S7: 'FAIL' } },
  { name: 'inject 少 locale', overrides: { injectRhs: '["slots"]' }, expect: { S5: 'FAIL' } },
  { name: '缺少 main 注册', overrides: { includeMain: false }, expect: { S2: 'FAIL', S6: 'FAIL' } },
  { name: '缺少 panellist 注册', overrides: { includePanellist: false }, expect: { S1: 'FAIL', S2: 'FAIL', S3: 'FAIL', S4: 'FAIL', S7: 'FAIL' } },
  // ↓ S7（label 追到字典值）的专项夹具
  { name: 'S7：中文标签值写错（ZH.nav = "错误标签"）', overrides: { zhNav: '错误标签' }, expect: { S7: 'FAIL' } },
  { name: 'S7：en 字典缺 nav 键', overrides: { includeEnNav: false }, expect: { S7: 'FAIL' } },
  { name: 'S7：字典键不存在（label 查 t("nope")）', overrides: { label: '() => t("nope")' }, expect: { S7: 'FAIL' } },
  { name: 'S7：thunk 里抽不出字典键（label = () => 42）', overrides: { label: '() => 42' }, expect: { S7: 'FAIL' } },
  { name: 'S7：label 直接写成字符串且正确', overrides: { label: '"指纹检测"' }, expect: {} },
  { name: 'S7：label 直接写成字符串但值错', overrides: { label: '"Fingerprint"' }, expect: { S7: 'FAIL' } },
  { name: 'S7：locale.register 缺失 → 回退按 const ZH/EN 约定核对（应仍 PASS）', overrides: { includeLocaleRegister: false }, expect: {} },
  { name: 'S7：字典用 ES6 简写 { zh, en }（应仍 PASS）', overrides: { registerStyle: 'shorthand' }, expect: {} },
  { name: 'S7：ES6 简写 + 中文标签值写错', overrides: { registerStyle: 'shorthand', zhNav: '错误标签' }, expect: { S7: 'FAIL' } },
  { name: 'S7：多套字典 → 按 locale 选中正确的那份（应 PASS）', overrides: { extraRegisterFirst: true }, expect: {} },
]

const SLOT_IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']

/**
 * 跑夹具自测并打印结论。
 * @returns {boolean} 全部断言通过且七项都"可达 PASS 且可达 FAIL"时为 true
 */
function runSlotSelfTest() {
  const reachable = new Map(SLOT_IDS.map((id) => [id, { pass: false, fail: false }]))
  let mismatches = 0
  process.stdout.write(`槽位检查夹具自测（--self-test）：确认 ${SLOT_IDS.join('/')} 每一项既可达 PASS 也可达 FAIL\n\n`)
  process.stdout.write(`（${SLOT_FIXTURES.length} 个夹具 × ${SLOT_IDS.length} 项 = ${SLOT_FIXTURES.length * SLOT_IDS.length} 个断言）\n\n`)
  for (const fixture of SLOT_FIXTURES) {
    const verdict = judgeSlots(stripComments(slotFixtureSource(fixture.overrides)))
    const got = new Map(verdict.entries.map((entry) => [entry.id, entry.status]))
    const cells = []
    for (const id of SLOT_IDS) {
      const want = fixture.expect[id] ?? 'PASS'
      const actual = got.get(id) ?? 'MISSING'
      if (actual === 'PASS') reachable.get(id).pass = true
      if (actual === 'FAIL') reachable.get(id).fail = true
      const ok = actual === want
      if (!ok) mismatches += 1
      cells.push(`${id}:${actual}${ok ? '' : `(期望${want}!)`}`)
    }
    process.stdout.write(`  ${mismatches === 0 ? '·' : '·'} ${fixture.name}\n      ${cells.join('  ')}\n`)
    for (const id of SLOT_IDS) {
      const want = fixture.expect[id] ?? 'PASS'
      const actual = got.get(id) ?? 'MISSING'
      if (actual !== want) {
        const detail = verdict.entries.find((entry) => entry.id === id)
        process.stdout.write(`      ✘ ${id} 期望 ${want}、实际 ${actual}：${(detail?.evidence ?? []).join(' | ')}\n`)
      }
    }
  }
  process.stdout.write('\n七项可达性（必须两项都为"是"）：\n')
  let unreachable = 0
  for (const id of SLOT_IDS) {
    const state = reachable.get(id)
    if (!state.pass || !state.fail) unreachable += 1
    process.stdout.write(`  ${id}  可达 PASS: ${state.pass ? '是' : '否'}   可达 FAIL: ${state.fail ? '是' : '否'}\n`)
  }
  const ok = mismatches === 0 && unreachable === 0
  process.stdout.write(`\n断言不符 ${mismatches} 处；不可达项 ${unreachable} 项\n`)
  process.stdout.write(`结论: ${ok ? 'PASS（七项都可红可绿，无死代码）' : 'FAIL（夹具或判定逻辑有问题）'}\n`)
  return ok
}

// ─────────── 发布清单判定（C7 / X5 / X6 的唯一实现，主流程与 --self-test 共用） ───────────
//
// 背景：C7 的语义在"发布"视角下与"本地开发"**相反**。
//   本地开发：刻意**不声明** engines.dsh / 不声明 dsh peer（避免不兼容时被宿主静默 skip）。
//   发布：**必须**声明 engines.dsh 且其范围覆盖当前运行时，使用者才知道能不能装。
// 这里实现的是**发布**语义。

/** 解析 semver（支持 x/* 通配与预发布段）；非法返回 null。 */
function parseSemver(text) {
  const match = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
    String(text ?? '').trim(),
  )
  if (match === null) return null
  const num = (value) => (/^\d+$/u.test(value ?? '') ? Number(value) : 0)
  const wild = (value) => value === undefined || /^[xX*]$/u.test(value)
  return {
    major: num(match[1]),
    minor: num(match[2]),
    patch: num(match[3]),
    pre: match[4] === undefined ? null : match[4].split('.'),
    hasMinor: !wild(match[2]),
    hasPatch: !wild(match[3]),
    wildMinor: match[2] !== undefined && /^[xX*]$/u.test(match[2]),
    wildPatch: match[3] !== undefined && /^[xX*]$/u.test(match[3]),
  }
}

/** semver 预发布段比较（无预发布 > 有预发布）。 */
function comparePre(left, right) {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const a = left[i]
    const b = right[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNum = /^\d+$/u.test(a)
    const bNum = /^\d+$/u.test(b)
    if (aNum && bNum) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1
      continue
    }
    if (aNum) return -1
    if (bNum) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** 完整 semver 比较。 */
function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePre(left.pre, right.pre)
}

/** 两个版本的主次修订号元组是否相同。 */
function sameTuple(left, right) {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch
}

/** 把单个比较子展开成 [{op, ver}]；非法返回 null。 */
function parseComparator(token) {
  const match = /^(\^|~|>=|<=|>|<|=)?v?(.+)$/u.exec(token)
  if (match === null) return null
  const op = match[1] ?? ''
  const version = parseSemver(match[2])
  if (version === null) return null
  const plainRange = (base, upper) => [{ op: '>=', ver: base }, { op: '<', ver: upper }]
  // 通配 / 省略段 → X-range
  if (version.wildMinor || (!version.hasMinor && (op === '' || op === '='))) {
    return plainRange(
      { ...version, minor: 0, patch: 0, pre: null },
      { major: version.major + 1, minor: 0, patch: 0, pre: null },
    )
  }
  if (version.wildPatch || (!version.hasPatch && (op === '' || op === '='))) {
    return plainRange(
      { ...version, patch: 0, pre: null },
      { major: version.major, minor: version.minor + 1, patch: 0, pre: null },
    )
  }
  if (op === '^') {
    let upper
    if (version.major > 0) upper = { major: version.major + 1, minor: 0, patch: 0, pre: null }
    else if (version.minor > 0) upper = { major: 0, minor: version.minor + 1, patch: 0, pre: null }
    else upper = { major: 0, minor: 0, patch: version.patch + 1, pre: null }
    return plainRange(version, upper)
  }
  if (op === '~') {
    return plainRange(version, { major: version.major, minor: version.minor + 1, patch: 0, pre: null })
  }
  return [{ op: op === '' ? '=' : op, ver: version }]
}

/** 解析 range 成 OR 组（每组是 AND 的比较子数组）；非法返回 null。 */
function parseRange(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const groups = []
  for (const group of raw.split('||')) {
    const tokens = group.trim().split(/\s+/u).filter((token) => token !== '')
    if (tokens.length === 0) return null
    const comparators = []
    for (const token of tokens) {
      const parsed = parseComparator(token)
      if (parsed === null) return null
      comparators.push(...parsed)
    }
    groups.push(comparators)
  }
  return groups
}

/** 单个比较子判定。 */
function testComparator(version, comparator) {
  const diff = compareSemver(version, comparator.ver)
  if (comparator.op === '>') return diff > 0
  if (comparator.op === '>=') return diff >= 0
  if (comparator.op === '<') return diff < 0
  if (comparator.op === '<=') return diff <= 0
  return diff === 0
}

/**
 * 判断 `version` 是否满足 `range`（npm 语义，含**预发布准入规则**）。
 * 预发布准入：若 version 带预发布段，则组内**必须**存在一个比较子，其主次修订号元组与 version 相同**且**也带预发布段。
 * （这条很关键：`>=0.2.0` 不接受 `0.2.1-rc.3`，而 `>=0.2.1-rc.2 <0.3.0` 接受它。）
 * @returns {{ok:boolean, reason:string, groups:Array|null}}
 */
function satisfiesRange(versionText, rangeText) {
  const version = parseSemver(versionText)
  const groups = parseRange(rangeText)
  if (version === null) return { ok: false, reason: `运行时版本 ${JSON.stringify(versionText)} 自身非法`, groups: null }
  if (groups === null) return { ok: false, reason: `range ${JSON.stringify(rangeText)} 不是合法 semver range`, groups: null }
  const tried = []
  for (const comparators of groups) {
    const failed = comparators.filter((comparator) => !testComparator(version, comparator))
    const text = comparators.map((comparator) => `${comparator.op}${comparator.ver.major}.${comparator.ver.minor}.${comparator.ver.patch}${comparator.ver.pre === null ? '' : '-' + comparator.ver.pre.join('.')}`).join(' ')
    if (failed.length > 0) {
      tried.push(`组 [${text}] 不满足：${failed.map((comparator) => `${comparator.op}${comparator.ver.major}.${comparator.ver.minor}.${comparator.ver.patch}${comparator.ver.pre === null ? '' : '-' + comparator.ver.pre.join('.')}`).join(', ')} 未通过`)
      continue
    }
    if (version.pre !== null) {
      const admitted = comparators.some((comparator) => comparator.ver.pre !== null && sameTuple(comparator.ver, version))
      if (!admitted) {
        tried.push(`组 [${text}] 数值上通过，但**预发布准入**失败：组内没有一个比较子同时满足「元组相同 + 带预发布段」（version 带预发布段）`)
        continue
      }
      tried.push(`组 [${text}] 通过，且预发布准入成立 ✔`)
    } else {
      tried.push(`组 [${text}] 通过 ✔`)
    }
    return { ok: true, reason: tried.join('；'), groups }
  }
  return { ok: false, reason: tried.join('；'), groups }
}

/** C7 的输出要显示判定对象，而判定对象现在是动态的 ⇒ 标题也做成函数。 */
function manifestTitles(runtimeVersion) {
  return {
    C7: `已声明 engines.dsh，且范围覆盖运行时 ${runtimeVersion}（发布要求）`,
    X5: `package.json license === ${JSON.stringify(REQUIRED_LICENSE)}（发布要求）`,
    X6: 'package.json 不含 private，或 private !== true（发布要求）',
  }
}

/** 读一个 package.json 并返回其 version；任何失败都返回 null（不抛）。 */
function readPackageVersionFrom(packageJsonPath) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    return typeof parsed?.version === 'string' && parsed.version.trim() !== '' ? parsed.version.trim() : null
  } catch {
    return null
  }
}

/**
 * 动态读取已装 DSH：候选路径表。
 *
 * **为什么是一张表而不是单一路径**（实测依据）：本机上 `@deepseek-ai/dsh` **不在** profile 的
 * `node_modules` 里 —— profile 只携带 `dsh-brand` / `dsh-typert-protocol` / `cosmokit` / `schemastery`
 * 这些**随附包**，且它们是**实体目录**而非指向安装树的链接；`@deepseek-ai/dsh` 的唯一副本在
 * Electron 安装树里（非 profile 可达）。不同安装方式落点不同，所以只能逐条试，
 * 并把"试过哪些"写进输出。
 *
 * 表里**不含任何机器专属字面量**：全部由 `DSH_HOME` / profileDir / pluginDir 推导，或来自环境变量。
 * @param {string|null|undefined} extraPackagePath 由 `--dsh-pkg` 指定的额外候选（排最前）
 * @returns {string[]} 去重后的候选绝对路径
 */
function defaultRuntimeCandidates(extraPackagePath) {
  const out = []
  const push = (candidate) => {
    if (typeof candidate === 'string' && candidate !== '' && !out.includes(candidate)) out.push(candidate)
  }
  const rel = ['node_modules', '@deepseek-ai', 'dsh', 'package.json']
  if (typeof extraPackagePath === 'string' && extraPackagePath !== '') push(extraPackagePath)
  push(join(PROFILE_DIR, ...rel))
  push(join(PLUGIN_DIR, ...rel))
  // 从 pluginDir / profileDir 逐级向上找（源码 checkout、monorepo 等布局）
  let up = PLUGIN_DIR
  for (let i = 0; i < 4; i += 1) {
    const next = dirname(up)
    if (next === up) break
    up = next
    push(join(up, ...rel))
  }
  up = PROFILE_DIR
  for (let i = 0; i < 4; i += 1) {
    const next = dirname(up)
    if (next === up) break
    up = next
    push(join(up, ...rel))
  }
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
    push(join(process.env.DSH_HOME, ...rel))
  }
  // 环境里若给了运行时/安装目录，也试一下（非标准安装的逃生口）
  for (const key of ['DSH_RUNTIME_DIR', 'DSH_INSTALL_DIR', 'DSH_DSH_DIR']) {
    const base = process.env[key]
    if (typeof base === 'string' && base !== '') push(join(base, ...rel))
  }
  // 兄弟扫描：profile 的 @deepseek-ai/* 里若已有随附包，就在**同一层**找 dsh
  const scoped = join(PROFILE_DIR, 'node_modules', '@deepseek-ai')
  try {
    for (const entry of readdirSync(scoped)) push(join(scoped, entry, '..', 'dsh', 'package.json'))
  } catch {
    /* 没有该目录就算了 */
  }
  return out
}

/**
 * C7 判定对象（运行时 DSH 版本）的**三级取值**，优先级从高到低：
 *   1. `--dsh-version <ver>` 显式覆盖（给 CI / 手动指定用）
 *   2. 动态读取已装 DSH：按候选表读 `@deepseek-ai/dsh/package.json` 的 `version`
 *   3. 回落硬编码常量 `RUNTIME_VERSION_AT_CAPTURE`（**采集时刻**的值，输出会标注"可能已过时"）
 *
 * 之所以要三级：硬编码常量在 DSH 升级后会给出**错误结论**（不是"过时提示"，是**判错**）。
 * 三级都失败也必须给出可解释的结果，**绝不抛**。
 * @param {{explicit?:string|null, extraPackagePath?:string|null, candidates?:string[], readVersion?:(p:string)=>(string|null)}} options
 * @returns {{version:string, source:'explicit'|'dynamic'|'fallback', sourceLabel:string, detail:string, probe:Array<{path:string,version:string|null,ok:boolean}>}}
 */
function resolveRuntimeVersion(options = {}) {
  const explicit = typeof options.explicit === 'string' && options.explicit.trim() !== '' ? options.explicit.trim() : null
  if (explicit !== null) {
    return {
      version: explicit,
      source: 'explicit',
      sourceLabel: '来源：--dsh-version 显式指定',
      detail: '--dsh-version 显式指定（最高优先级，因此跳过了动态读取）',
      probe: [],
    }
  }
  const candidates = Array.isArray(options.candidates)
    ? options.candidates
    : defaultRuntimeCandidates(options.extraPackagePath)
  const readVersion = typeof options.readVersion === 'function' ? options.readVersion : readPackageVersionFrom
  const probe = []
  for (const candidate of candidates) {
    let version = null
    try {
      version = readVersion(candidate)
    } catch {
      version = null
    }
    const ok = typeof version === 'string' && version !== ''
    probe.push({ path: candidate, version: ok ? version : null, ok })
    if (ok) {
      return {
        version,
        source: 'dynamic',
        sourceLabel: '来源：动态读取 @deepseek-ai/dsh/package.json',
        detail: `动态读取成功：${candidate} → version=${version}`,
        probe,
      }
    }
  }
  return {
    version: RUNTIME_VERSION_AT_CAPTURE,
    source: 'fallback',
    sourceLabel: `来源：硬编码常量 —— 采集时刻 ${CAPTURE_DATE}，可能已过时`,
    detail: `动态读取失败（已试 ${probe.length} 个候选路径，均读不到 version）⇒ 回落到采集时刻常量`,
    probe,
  }
}

/**
 * 对一份 package.json 对象判定 C7 / X5 / X6 —— **发布就绪性**。
 * 抽成纯函数：主流程与 `--self-test` 共用同一份判定，避免自测与真实检查漂移。
 * @param {object} pkg 已解析的 package.json
 * @param {{version:string, source:string, sourceLabel:string, detail:string}} runtime C7 的判定对象（由 resolveRuntimeVersion 给出）
 * @returns {{entries: Array<{id:string,title:string,status:string,evidence:string[]}>}}
 */
function judgeManifest(pkg, runtime) {
  const titles = manifestTitles(runtime.version)
  const entries = []
  const add = (id, status, evidence) => entries.push({ id, title: titles[id], status, evidence })
  const sourceLine = `判定对象 = ${runtime.version}  （${runtime.sourceLabel}）`
  /** 回落路径必须显式提示"可能已过时"，否则这个结论会误导人。 */
  const sourceWarn =
    runtime.source === 'fallback'
      ? [`[⚠️ 注意] 判定对象来自**硬编码常量**（采集时刻 ${CAPTURE_DATE}），可能已过时 —— 若你的 DSH 已升级，请用 --dsh-version <ver> 复核。`]
      : []

  // ── C7：必须声明 engines.dsh，且覆盖当前运行时 ──
  {
    const raw = pkg?.engines?.dsh
    if (raw === undefined) {
      add('C7', 'FAIL', [
        '未声明 engines.dsh ✘ —— 发布包必须声明它，使用者/宿主才能判断兼容性。',
        sourceLine,
        `[期望] engines.dsh 是一个覆盖 ${runtime.version} 的 semver range，例如 ${JSON.stringify('>=0.2.1-rc.2 <0.3.0')}。`,
        '[note] 与"本地开发"的取舍相反：本地开发刻意不声明它（避免不兼容时被静默 skip）；发布必须声明。',
        ...sourceWarn,
      ])
    } else if (typeof raw !== 'string') {
      add('C7', 'FAIL', [
        `engines.dsh 不是字符串 ✘（实际类型 ${typeof raw}，值 ${JSON.stringify(raw)}）。`,
        sourceLine,
        '[期望] 合法 semver range 字符串。',
        ...sourceWarn,
      ])
    } else {
      const verdict = satisfiesRange(runtime.version, raw)
      const evidence = [
        `engines.dsh = ${JSON.stringify(raw)}`,
        sourceLine,
        `判定对象来源细节：${runtime.detail}`,
        `判定过程：${verdict.reason}`,
      ]
      if (verdict.groups === null) {
        evidence.push('[期望] 合法 semver range 字符串（支持 = > >= < <= ^ ~ 与 x/* 通配、`||` 分组）。')
      } else {
        evidence.push(`解析出的 OR 组数 = ${verdict.groups.length}`)
      }
      const peers = Object.keys(pkg.peerDependencies ?? {})
      const dshPeers = peers.filter((name) => /^@deepseek-ai\/dsh(?:-|$)/u.test(name))
      if (dshPeers.length > 0) {
        evidence.push(
          `[info] 同时声明了 ${dshPeers.length} 个 @deepseek-ai/dsh* peer（${dshPeers.join(', ')}）—— 有 engines.dsh 时 peer 会被忽略而失效；**不判 FAIL**，仅提示可以删掉以免误导。`,
        )
      }
      evidence.push('[依据] dsh-app-boot/lib/index.js:301-304：声明了 engines.dsh 就只看它、忽略全部 dsh peer。')
      evidence.push(...sourceWarn)
      add('C7', verdict.ok ? 'PASS' : 'FAIL', evidence)
    }
  }

  // ── X5：license === MIT ──
  {
    const license = pkg?.license
    add('X5', license === REQUIRED_LICENSE ? 'PASS' : 'FAIL', [
      `license 实际=${JSON.stringify(license ?? null)}；要求 ${JSON.stringify(REQUIRED_LICENSE)}`,
      license === REQUIRED_LICENSE ? '一致 ✔' : '缺失或不一致 ✘ —— 开源发布必须明确许可证。',
    ])
  }

  // ── X6：private 不得为 true ──
  {
    const isPrivate = pkg?.private === true
    add('X6', isPrivate ? 'FAIL' : 'PASS', [
      `private 实际=${JSON.stringify(pkg?.private ?? null)}`,
      isPrivate
        ? 'private === true ✘ —— `private: true` 会阻止 `npm publish`，发布包必须去掉它（或置 false）。'
        : '不是 true ✔（缺失或 false 都可接受）',
    ])
  }

  return { entries }
}

/** 发布清单夹具：`{name, pkg, expect}`；`expect` 未列出的检查默认期望 PASS。 */
const MANIFEST_FIXTURES = [
  { name: '发布就绪（基准）', pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, license: 'MIT' }, expect: {} },
  { name: '缺 engines.dsh', pkg: { license: 'MIT' }, expect: { C7: 'FAIL' } },
  { name: 'engines.dsh 非字符串（数字）', pkg: { engines: { dsh: 3 }, license: 'MIT' }, expect: { C7: 'FAIL' } },
  { name: 'engines.dsh 空串', pkg: { engines: { dsh: '' }, license: 'MIT' }, expect: { C7: 'FAIL' } },
  { name: 'engines.dsh 非法 range', pkg: { engines: { dsh: 'not-a-range' }, license: 'MIT' }, expect: { C7: 'FAIL' } },
  { name: 'range 下界过高（>=0.2.2）', pkg: { engines: { dsh: '>=0.2.2' }, license: 'MIT' }, expect: { C7: 'FAIL' } },
  { name: 'range 上界排除运行时（<0.2.0）', pkg: { engines: { dsh: '<0.2.0' }, license: 'MIT' }, expect: { C7: 'FAIL' } },
  { name: 'range 落到下一段（>=0.3.0）', pkg: { engines: { dsh: '>=0.3.0' }, license: 'MIT' }, expect: { C7: 'FAIL' } },
  {
    name: '数值通过但**预发布不准入**（>=0.2.0）',
    pkg: { engines: { dsh: '>=0.2.0' }, license: 'MIT' },
    expect: { C7: 'FAIL' },
  },
  {
    name: '通配 0.2.x（同样预发布不准入 → FAIL）',
    pkg: { engines: { dsh: '0.2.x' }, license: 'MIT' },
    expect: { C7: 'FAIL' },
  },
  { name: '写法 ^0.2.1-rc.2（预发布准入成立）', pkg: { engines: { dsh: '^0.2.1-rc.2' }, license: 'MIT' }, expect: {} },
  { name: '写法 ~0.2.1-rc.2', pkg: { engines: { dsh: '~0.2.1-rc.2' }, license: 'MIT' }, expect: {} },
  {
    name: '写法 || 分组（第一组不中、第二组覆盖）',
    pkg: { engines: { dsh: '>=0.1.0 <0.2.0 || >=0.2.1-rc.2 <0.3.0' }, license: 'MIT' },
    expect: {},
  },
  {
    name: '精确锁定当前运行时（=0.2.1-rc.3）',
    pkg: { engines: { dsh: '=0.2.1-rc.3' }, license: 'MIT' },
    expect: {},
  },
  { name: 'license 不是 MIT', pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, license: 'Apache-2.0' }, expect: { X5: 'FAIL' } },
  { name: '缺 license', pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' } }, expect: { X5: 'FAIL' } },
  {
    name: 'private: true（阻止发布）',
    pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, license: 'MIT', private: true },
    expect: { X6: 'FAIL' },
  },
  {
    name: 'private: false（可接受）',
    pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, license: 'MIT', private: false },
    expect: {},
  },
  {
    name: '同时声明 dsh peer（INFO，不 FAIL）',
    pkg: {
      engines: { dsh: '>=0.2.1-rc.2 <0.3.0' },
      license: 'MIT',
      peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' },
    },
    expect: {},
  },
  // ── 三级取值：三条路径各走一遍红与绿（证明"判定对象从哪来"被真的接进了判定链）──
  {
    name: '来源 explicit + 0.2.1-rc.3 → 覆盖（PASS）',
    runtime: { version: '0.2.1-rc.3', source: 'explicit', sourceLabel: '来源：--dsh-version 显式指定', detail: '--dsh-version 显式指定' },
    pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, license: 'MIT' },
    expect: {},
    expectEvidence: { C7: ['判定对象 = 0.2.1-rc.3', '来源：--dsh-version 显式指定'] },
  },
  {
    name: '来源 explicit + 0.3.0 → 不覆盖（FAIL，且红的理由是"范围不覆盖"而非"读不到"）',
    runtime: { version: '0.3.0', source: 'explicit', sourceLabel: '来源：--dsh-version 显式指定', detail: '--dsh-version 显式指定' },
    pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, license: 'MIT' },
    expect: { C7: 'FAIL' },
    expectEvidence: { C7: ['判定对象 = 0.3.0', '不满足'] },
  },
  {
    name: '来源 dynamic + 0.2.1 → 覆盖（PASS）',
    runtime: { version: '0.2.1', source: 'dynamic', sourceLabel: '来源：动态读取 @deepseek-ai/dsh/package.json', detail: '动态读取成功' },
    pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, license: 'MIT' },
    expect: {},
    expectEvidence: { C7: ['来源：动态读取 @deepseek-ai/dsh/package.json'] },
  },
  {
    name: '来源 dynamic + 0.3.0 → 不覆盖（FAIL）',
    runtime: { version: '0.3.0', source: 'dynamic', sourceLabel: '来源：动态读取 @deepseek-ai/dsh/package.json', detail: '动态读取成功' },
    pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, license: 'MIT' },
    expect: { C7: 'FAIL' },
  },
  {
    name: '来源 fallback + 0.2.1-rc.3 → 覆盖（PASS），**必须**标注"可能已过时"',
    runtime: {
      version: '0.2.1-rc.3',
      source: 'fallback',
      sourceLabel: `来源：硬编码常量 —— 采集时刻 ${CAPTURE_DATE}，可能已过时`,
      detail: '动态读取失败 ⇒ 回落',
    },
    pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, license: 'MIT' },
    expect: {},
    expectEvidence: { C7: ['来源：硬编码常量', '可能已过时', CAPTURE_DATE] },
  },
  {
    name: '来源 fallback + 0.3.0 → 不覆盖（FAIL），同样标注可能已过时',
    runtime: {
      version: '0.3.0',
      source: 'fallback',
      sourceLabel: `来源：硬编码常量 —— 采集时刻 ${CAPTURE_DATE}，可能已过时`,
      detail: '动态读取失败 ⇒ 回落',
    },
    pkg: { engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, license: 'MIT' },
    expect: { C7: 'FAIL' },
    expectEvidence: { C7: ['可能已过时'] },
  },
]

/** 未显式给 runtime 的夹具，默认用"动态读取成功、读到采集时刻那个版本"。 */
const DEFAULT_FIXTURE_RUNTIME = {
  version: RUNTIME_VERSION_AT_CAPTURE,
  source: 'dynamic',
  sourceLabel: '来源：夹具默认（模拟动态读取成功）',
  detail: `夹具默认：模拟动态读取成功 → ${RUNTIME_VERSION_AT_CAPTURE}`,
}

/**
 * 跑发布清单夹具自测（C7 / X5 / X6），证明三项既可达 PASS 也可达 FAIL，
 * 并证明**三级取值（explicit / dynamic / fallback）每一路都各自可红可绿**。
 * 走的是与主流程**同一份** judgeManifest()。
 * @returns {boolean} 状态断言与证据断言全过、三项可达、三条来源路径各自可红可绿时为 true
 */
function runManifestSelfTest() {
  const ids = ['C7', 'X5', 'X6']
  const sources = ['explicit', 'dynamic', 'fallback']
  const reachable = new Map(ids.map((id) => [id, { pass: false, fail: false }]))
  const routeReach = new Map(sources.map((source) => [source, { pass: false, fail: false, cases: 0 }]))
  let mismatches = 0
  let evidenceChecks = 0
  process.stdout.write(`\n发布清单夹具自测（C7 / X5 / X6 —— 发布语义）：\n\n`)
  process.stdout.write(`（${MANIFEST_FIXTURES.length} 个夹具 × ${ids.length} 项 = ${MANIFEST_FIXTURES.length * ids.length} 个状态断言）\n\n`)
  for (const fixture of MANIFEST_FIXTURES) {
    const runtime = fixture.runtime ?? DEFAULT_FIXTURE_RUNTIME
    const verdict = judgeManifest(fixture.pkg, runtime)
    const got = new Map(verdict.entries.map((entry) => [entry.id, entry.status]))
    const cells = []
    let fixtureBad = false
    for (const id of ids) {
      const want = fixture.expect[id] ?? 'PASS'
      const actual = got.get(id) ?? 'MISSING'
      if (actual === 'PASS') reachable.get(id).pass = true
      if (actual === 'FAIL') reachable.get(id).fail = true
      const ok = actual === want
      if (!ok) {
        mismatches += 1
        fixtureBad = true
      }
      cells.push(`${id}:${actual}${ok ? '' : `(期望${want}!)`}`)
    }
    // 三级取值的可达性：只在夹具**显式给了 runtime** 时统计，保证三路各有一组红/绿样例
    if (fixture.runtime !== undefined) {
      const slot = routeReach.get(runtime.source)
      const status = got.get('C7')
      if (status === 'PASS') slot.pass = true
      if (status === 'FAIL') slot.fail = true
      slot.cases += 1
    }
    // 证据断言：证明输出里**真的带了来源标注**（只看 PASS/FAIL 是测不出这个的）
    for (const [id, needles] of Object.entries(fixture.expectEvidence ?? {})) {
      const entry = verdict.entries.find((item) => item.id === id)
      const text = (entry?.evidence ?? []).join('\n')
      for (const needle of needles) {
        evidenceChecks += 1
        if (!text.includes(needle)) {
          mismatches += 1
          fixtureBad = true
          process.stdout.write(`      ✘ 证据断言失败：${id} 的输出里找不到 ${JSON.stringify(needle)}\n`)
        }
      }
    }
    process.stdout.write(`  ${fixtureBad ? '✘' : '·'} ${fixture.name}\n      ${cells.join('  ')}\n`)
    if (fixtureBad) {
      for (const id of ids) {
        const want = fixture.expect[id] ?? 'PASS'
        const actual = got.get(id) ?? 'MISSING'
        if (actual !== want) {
          const detail = verdict.entries.find((entry) => entry.id === id)
          process.stdout.write(`      ✘ ${id} 期望 ${want}、实际 ${actual}：${(detail?.evidence ?? []).join(' | ')}\n`)
        }
      }
    }
  }
  process.stdout.write('\n三项可达性（必须两项都为"是"）：\n')
  let unreachable = 0
  for (const id of ids) {
    const state = reachable.get(id)
    if (!state.pass || !state.fail) unreachable += 1
    process.stdout.write(`  ${id}  可达 PASS: ${state.pass ? '是' : '否'}   可达 FAIL: ${state.fail ? '是' : '否'}\n`)
  }
  process.stdout.write('\n三级取值的可达性（每一路都必须既能 PASS 也能 FAIL）：\n')
  for (const source of sources) {
    const state = routeReach.get(source)
    if (!state.pass || !state.fail) unreachable += 1
    process.stdout.write(
      `  来源 ${source.padEnd(9)} 可达 PASS: ${state.pass ? '是' : '否'}   可达 FAIL: ${state.fail ? '是' : '否'}   （夹具 ${state.cases} 个）\n`,
    )
  }
  const ok = mismatches === 0 && unreachable === 0
  process.stdout.write(`\n证据断言 ${evidenceChecks} 条；断言不符 ${mismatches} 处；不可达项 ${unreachable} 项\n`)
  process.stdout.write(`结论: ${ok ? 'PASS（C7/X5/X6 与三级取值都可红可绿，无死代码）' : 'FAIL（夹具或判定逻辑有问题）'}\n`)
  return ok
}

/** 三级取值解析器的夹具（注入 readVersion ⇒ 完全不碰文件系统）。 */
const RUNTIME_FIXTURES = [
  {
    name: 'explicit 优先（即使候选可读也用它）',
    options: { explicit: '0.3.0', candidates: ['cand-a'], readVersion: () => '0.2.1-rc.3' },
    expect: { version: '0.3.0', source: 'explicit' },
  },
  {
    name: 'explicit 两侧空白会被 trim',
    options: { explicit: '  0.2.1-rc.3  ', candidates: [], readVersion: () => null },
    expect: { version: '0.2.1-rc.3', source: 'explicit' },
  },
  {
    name: 'explicit 只有空白 ⇒ 视为未指定，退回动态',
    options: { explicit: '   ', candidates: ['cand-a'], readVersion: () => '0.2.1' },
    expect: { version: '0.2.1', source: 'dynamic' },
  },
  {
    name: '动态读取成功（第一个候选即命中）',
    options: { candidates: ['cand-a'], readVersion: () => '0.2.1-rc.3' },
    expect: { version: '0.2.1-rc.3', source: 'dynamic' },
  },
  {
    name: '动态读取：第一个失败、第二个命中',
    options: { candidates: ['cand-a', 'cand-b'], readVersion: (p) => (p === 'cand-b' ? '0.2.1' : null) },
    expect: { version: '0.2.1', source: 'dynamic' },
  },
  {
    name: '动态读取全部失败 ⇒ 回落常量 + 标注"可能已过时"',
    options: { candidates: ['cand-a', 'cand-b'], readVersion: () => null },
    expect: { version: RUNTIME_VERSION_AT_CAPTURE, source: 'fallback' },
    expectSourceLabelHas: ['硬编码常量', '可能已过时', CAPTURE_DATE],
  },
  {
    name: '动态读取抛异常 ⇒ 当作读不到（不许崩）',
    options: {
      candidates: ['cand-a'],
      readVersion: () => {
        throw new Error('boom')
      },
    },
    expect: { version: RUNTIME_VERSION_AT_CAPTURE, source: 'fallback' },
  },
  {
    name: '候选表为空 ⇒ 直接回落',
    options: { candidates: [], readVersion: () => '0.2.1' },
    expect: { version: RUNTIME_VERSION_AT_CAPTURE, source: 'fallback' },
  },
  {
    name: '读到"未来的 DSH 版本"也能如实用上（0.2.5-rc.1）',
    options: { candidates: ['cand-a'], readVersion: () => '0.2.5-rc.1' },
    expect: { version: '0.2.5-rc.1', source: 'dynamic' },
  },
]

/**
 * 跑三级取值解析器的夹具自测，并证明三条路径各自可达。
 * @returns {boolean} 全部断言通过、且 explicit/dynamic/fallback 三路都真的被走到时返回 true
 */
function runRuntimeSelfTest() {
  const sources = ['explicit', 'dynamic', 'fallback']
  const reachable = new Map(sources.map((source) => [source, false]))
  let mismatches = 0
  let labelChecks = 0
  process.stdout.write(`\n三级取值夹具自测（C7 的判定对象从哪来）：\n\n`)
  process.stdout.write(`（${RUNTIME_FIXTURES.length} 个夹具 × 2 字段 = ${RUNTIME_FIXTURES.length * 2} 个状态断言）\n\n`)
  for (const fixture of RUNTIME_FIXTURES) {
    const got = resolveRuntimeVersion(fixture.options)
    let fixtureBad = false
    const cells = []
    for (const field of ['version', 'source']) {
      const want = fixture.expect[field]
      const actual = got[field]
      const ok = actual === want
      if (!ok) {
        mismatches += 1
        fixtureBad = true
      }
      cells.push(`${field}:${JSON.stringify(actual)}${ok ? '' : `(期望${JSON.stringify(want)}!)`}`)
    }
    if (reachable.has(got.source)) reachable.set(got.source, true)
    for (const needle of fixture.expectSourceLabelHas ?? []) {
      labelChecks += 1
      if (!String(got.sourceLabel).includes(needle)) {
        mismatches += 1
        fixtureBad = true
        process.stdout.write(`      ✘ sourceLabel 里找不到 ${JSON.stringify(needle)}：${JSON.stringify(got.sourceLabel)}\n`)
      }
    }
    process.stdout.write(`  ${fixtureBad ? '✘' : '·'} ${fixture.name}\n      ${cells.join('  ')}\n`)
    if (fixtureBad) process.stdout.write(`      sourceLabel = ${JSON.stringify(got.sourceLabel)}\n`)
    if (Array.isArray(fixture.options.candidates) && fixture.options.candidates.length > 0) {
      process.stdout.write(`      探测记录 ${got.probe.length} 条（已试候选数）\n`)
    }
  }
  process.stdout.write('\n三条路径可达性（每一条都必须被真的走到）：\n')
  let unreachable = 0
  for (const source of sources) {
    const hit = reachable.get(source) === true
    if (!hit) unreachable += 1
    process.stdout.write(`  来源 ${source.padEnd(9)} 被走到: ${hit ? '是' : '否'}\n`)
  }
  const ok = mismatches === 0 && unreachable === 0
  process.stdout.write(`\nsourceLabel 断言 ${labelChecks} 条；断言不符 ${mismatches} 处；不可达项 ${unreachable} 项\n`)
  process.stdout.write(`结论: ${ok ? 'PASS（三级取值三路都可走到，无死分支）' : 'FAIL（夹具或判定逻辑有问题）'}\n`)
  return ok
}

// ─────────────────────────── 读取输入 ───────────────────────────

const PLUGIN_EXISTS = existsSync(PLUGIN_DIR)
const pkgPath = join(PLUGIN_DIR, 'package.json')
const patchPath = join(PLUGIN_DIR, 'cordis.patch.yml')
const hostEntryPath = join(PLUGIN_DIR, 'lib', 'index.js')
/** 契约约定的客户端束默认位置；C4 解析到 exports["./client"] 的真值后会覆盖它。 */
const clientPath = join(PLUGIN_DIR, 'client.js')
/**
 * 实际要检查的客户端束路径，由 exports["./client"] 推导（而不是硬编码根目录 client.js）。
 * 这样即使客户端束被放在 lib/ 下，C10/C11/C12/X3 依然检查的是宿主真正会加载的那个文件。
 */
let resolvedClientPath = clientPath
let resolvedClientOrigin = '默认约定 <插件>/client.js'
/** 客户端束的"待产出"标记：声明了但文件还没落盘时，相关检查按 SKIP 处理并计入待产出清单。 */
let clientPending = false

let pkg = null
let pkgReadError = null

if (!ARGS.json) {
  process.stdout.write('dsh-fingerprint 装载自检（只读）\n')
  process.stdout.write(`  插件目录 : ${PLUGIN_DIR}\n`)
  process.stdout.write(`  profile  : ${PROFILE_DIR}\n`)
  process.stdout.write(`  链接位置 : ${LINK_PATH}\n`)
  process.stdout.write(`  node     : ${process.version}\n`)
  process.stdout.write(`  C7 判定对象: ${RUNTIME.version}  （${RUNTIME.sourceLabel}）\n`)
  process.stdout.write(`  时间     : ${new Date().toISOString()}\n\n`)
}

// ── --self-test：只跑夹具自测并退出（不碰任何被检文件） ─────────────────────
if (ARGS.selftest) {
  const slotsOk = runSlotSelfTest()
  const manifestOk = runManifestSelfTest()
  const runtimeOk = runRuntimeSelfTest()
  process.exit(slotsOk && manifestOk && runtimeOk ? 0 : 1)
}

if (!PLUGIN_EXISTS) {
  // 插件目录尚不存在：所有依赖它的检查一律 SKIP（不算 FAIL）
  const skipped = [
    ['C1', 'package.json 可解析；含 name / version / type==="module" / main（契约 §1、§2.2）'],
    ['C2', 'dsh.bundle.patch 存在且指向的文件真实存在（契约 §2.2）'],
    ['C3', 'dsh.client.platform === "web" 且未声明 dsh.client.inject（契约 §2.2）'],
    ['C4', 'exports["./client"] 存在且目标文件真实存在（契约 §2.2）'],
    ['C5', 'exports["."] 目标存在'],
    ['C6', 'cordis.patch.yml 含 - insert: 且 id==="fingerprint" / name==="dsh-fingerprint"（契约 §1）'],
    ['C7', MANIFEST_TITLES.C7],
    ['C8', 'profile 内 node_modules/dsh-fingerprint 是 junction/symlink 且指向插件目录'],
    ['C9', 'profile package.json：dependencies 为 link: 且 bundles 含 "dsh-fingerprint"'],
    ['C10', 'client.js 不是 ESM（无顶层 import/export 语句，契约 §2.2）'],
    ['C11', 'client.js 含 window.__ModuleLoader__.load( 且含 exports.apply（契约 §2.2）'],
    ['C12', 'client.js 中每个 require("...") 实参 ∈ 11 个外壳种子词白名单（契约 §2.2）'],
    ['C13', 'lib/index.js 存在且含 export function apply'],
    ['C14', '插件目录内不存在 node_modules/@deepseek-ai'],
    ['X1', 'package.json version === "0.1.0"（契约 §1 冻结值）'],
    ['X4', 'package.json name === "dsh-fingerprint"（契约 §1 冻结值）'],
    ['X5', MANIFEST_TITLES.X5],
    ['X6', MANIFEST_TITLES.X6],
    ['X2', '插件目录 node_modules 顶层只含 lmfpd-sdk（契约 §8）'],
    ['X3', 'client.js 含 exports.inject 或 inject =（契约 §2.2，cordis 服务名必需）'],
    ['S1', 'sidebar.panellist 注册的 id === "dsh-fingerprint"（契约 §1）'],
    ['S2', 'main 注册的 key === sidebar.panellist 注册的 id（契约 §2.1 一致性）'],
    ['S3', 'sidebar.panellist 注册的 order === 40（契约 §1）'],
    ['S4', 'sidebar.panellist 注册的 label 存在且为 thunk 或字符串（契约 §2.1）'],
    ['S5', "module.exports.inject === ['slots','locale']（契约 §12.9）"],
    ['S6', '页面注册在 slots.register 的 name: "main" 上（契约 §2.1）'],
    ['S7', `label 的实际中文值 === ${JSON.stringify(SIDEBAR_LABEL)}（thunk 追到 ZH 字典；契约 §1）`],
  ]
  for (const [id, title] of skipped) {
    report(id, title, 'SKIP', [`插件目录不存在: ${PLUGIN_DIR}`])
  }
} else {
  // ── C1：package.json 基本字段 ────────────────────────────────────────
  const pkgRead = readJson(pkgPath)
  if (!pkgRead.ok) {
    report('C1', 'package.json 可解析；含 name / version / type==="module" / main（契约 §1、§2.2）', 'FAIL', [
      `路径: ${pkgPath}`,
      pkgRead.error,
    ])
    pkgReadError = pkgRead.error
  } else {
    pkg = pkgRead.value
    const missing = []
    if (typeof pkg.name !== 'string' || pkg.name === '') missing.push('name')
    if (typeof pkg.version !== 'string' || pkg.version === '') missing.push('version')
    if (pkg.type !== 'module') missing.push(`type(实际=${JSON.stringify(pkg.type)}，要求 "module")`)
    if (typeof pkg.main !== 'string' || pkg.main === '') missing.push('main')
    const evidence = [
      `路径: ${pkgPath}`,
      `name=${JSON.stringify(pkg.name)}  version=${JSON.stringify(pkg.version)}  type=${JSON.stringify(pkg.type)}  main=${JSON.stringify(pkg.main)}`,
      '[note] §2.2 规定客户端入口只认 exports["./client"]、不看 main；但 W4 验收清单要求 main 存在。',
    ]
    if (missing.length > 0) {
      report('C1', 'package.json 可解析；含 name / version / type==="module" / main（契约 §1、§2.2）', 'FAIL', [
        ...evidence,
        `缺失或不合规字段: ${missing.join(', ')}`,
      ])
    } else {
      report('C1', 'package.json 可解析；含 name / version / type==="module" / main（契约 §1、§2.2）', 'PASS', evidence)
    }
  }

  // ── C2：dsh.bundle.patch ────────────────────────────────────────────
  if (pkg === null) {
    report('C2', 'dsh.bundle.patch 存在且指向的文件真实存在（契约 §2.2）', 'SKIP', [
      `package.json 不可用: ${pkgReadError ?? '未知原因'}`,
    ])
  } else {
    const declared = pkg.dsh?.bundle?.patch
    if (declared === undefined) {
      report('C2', 'dsh.bundle.patch 存在且指向的文件真实存在（契约 §2.2）', 'FAIL', [
        'package.json 缺少 dsh.bundle.patch —— 该包不会被当作组合包（bundle）装载。',
        '依据: dsh-app-boot/lib/index.js:1024 会抛出 "declares no dsh.bundle in its package.json" 并 skip。',
      ])
    } else {
      const declaredList = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : null
      const evidence = [`dsh.bundle.patch = ${JSON.stringify(declared)}`]
      if (declaredList === null) {
        report('C2', 'dsh.bundle.patch 存在且指向的文件真实存在（契约 §2.2）', 'FAIL', [
          ...evidence,
          '形状非法：必须是 string 或 string[]（dsh-app-boot/lib/index.js:517-521）。',
        ])
      } else {
        let bad = false
        for (const entry of declaredList) {
          if (typeof entry !== 'string') {
            bad = true
            evidence.push(`跳过非字符串项: ${JSON.stringify(entry)}`)
            continue
          }
          const target = resolveExportTarget(entry)
          const ok = target !== null && isFile(target)
          if (!ok) bad = true
          evidence.push(`${ok ? '存在' : '缺失'}  ${entry}  →  ${target}`)
        }
        report(
          'C2',
          'dsh.bundle.patch 存在且指向的文件真实存在（契约 §2.2）',
          bad ? 'FAIL' : 'PASS',
          evidence,
        )
      }
    }
  }

  // ── C3：dsh.client.platform 与 inject 省略 ──────────────────────────
  if (pkg === null) {
    report('C3', 'dsh.client.platform === "web" 且未声明 dsh.client.inject（契约 §2.2）', 'SKIP', [
      `package.json 不可用: ${pkgReadError ?? '未知原因'}`,
    ])
  } else {
    const client = pkg.dsh?.client
    const evidence = [`dsh.client = ${JSON.stringify(client)}`]
    if (client === undefined || client === null || typeof client !== 'object') {
      report('C3', 'dsh.client.platform === "web" 且未声明 dsh.client.inject（契约 §2.2）', 'FAIL', [
        ...evidence,
        '缺少 dsh.client 对象 —— 宿主不会把该包当作客户端插件。',
      ])
    } else {
      let bad = false
      if (client.platform !== 'web') {
        bad = true
        evidence.push(`platform 实际=${JSON.stringify(client.platform)}，要求严格等于 "web"（契约 §2.2）。`)
      } else {
        evidence.push('platform === "web" ✔')
      }
      if (Object.prototype.hasOwnProperty.call(client, 'inject')) {
        bad = true
        evidence.push(
          `声明了 dsh.client.inject = ${JSON.stringify(client.inject)} —— 契约 §2.2 要求一律省略（只依赖 11 个外壳种子词）。`,
        )
      } else {
        evidence.push('未声明 dsh.client.inject ✔（契约 §2.2 要求省略）')
      }
      report(
        'C3',
        'dsh.client.platform === "web" 且未声明 dsh.client.inject（契约 §2.2）',
        bad ? 'FAIL' : 'PASS',
        evidence,
      )
    }
  }

  // ── C4 / C5：exports ────────────────────────────────────────────────
  if (pkg === null) {
    for (const [id, title] of [
      ['C4', 'exports["./client"] 存在且目标文件真实存在（契约 §2.2）'],
      ['C5', 'exports["."] 目标存在'],
    ]) {
      report(id, title, 'SKIP', [`package.json 不可用: ${pkgReadError ?? '未知原因'}`])
    }
  } else {
    const exportsField = pkg.exports
    const clientEntry = exportEntry(exportsField, CLIENT_EXPORT_KEY)
    if (!clientEntry.present) {
      report('C4', 'exports["./client"] 存在且目标文件真实存在（契约 §2.2）', 'FAIL', [
        `exports = ${JSON.stringify(exportsField)}`,
        '缺少 "./client" 导出键 —— 宿主用 exports["./client"] 定位客户端束（契约 §2.2），不看 main。',
      ])
    } else if (clientEntry.target === null) {
      report('C4', 'exports["./client"] 存在且目标文件真实存在（契约 §2.2）', 'FAIL', [
        `exports["./client"] 形状 = ${clientEntry.form}，要求 string 或 {default:string}。`,
      ])
    } else {
      const target = resolveExportTarget(clientEntry.target)
      const ok = target !== null && isFile(target)
      if (target !== null) {
        resolvedClientPath = target
        resolvedClientOrigin = `exports["./client"] (${clientEntry.form})`
      }
      const evidence = [
        `exports["./client"] 形状 = ${clientEntry.form}`,
        `${clientEntry.target}  →  ${target}`,
        target !== null ? `后续 C10/C11/C12/X3 实际检查: ${resolvedClientPath}` : '无法解析出绝对路径。',
      ]
      if (ok) {
        evidence.push('目标文件存在 ✔')
        report('C4', 'exports["./client"] 存在且目标文件真实存在（契约 §2.2）', 'PASS', evidence)
      } else {
        // 结构性声明没问题，只是文件还没产出（由 W6 并行落盘）→ 按验收清单的 SKIP 规则处理
        clientPending = true
        evidence.push('目标文件尚未产出 ✘ —— 客户端束（W6）还没落盘。')
        evidence.push('[SKIP 理由] 声明本身合规，属"文件尚未就绪"；交付前此项必须转为 PASS。')
        report('C4', 'exports["./client"] 存在且目标文件真实存在（契约 §2.2）', 'SKIP', evidence)
      }
    }

    const rootEntry = exportEntry(exportsField, ROOT_EXPORT_KEY)
    if (!rootEntry.present) {
      report('C5', 'exports["."] 目标存在', 'FAIL', [
        `exports = ${JSON.stringify(exportsField)}`,
        '缺少 "." 导出键 —— 宿主半侧入口解析不到。',
      ])
    } else if (rootEntry.target === null) {
      report('C5', 'exports["."] 目标存在', 'FAIL', [`exports["."] 形状 = ${rootEntry.form}，要求 string 或 {default:string}。`])
    } else {
      const target = resolveExportTarget(rootEntry.target)
      const ok = target !== null && isFile(target)
      report('C5', 'exports["."] 目标存在', ok ? 'PASS' : 'FAIL', [
        `exports["."] 形状 = ${rootEntry.form}`,
        `${rootEntry.target}  →  ${target}`,
        ok ? '目标文件存在 ✔' : '目标文件缺失 ✘',
      ])
    }

    // ── X1：契约 §1 冻结版本 ──────────────────────────────────────────
    const version = pkg.version
    report(
      'X1',
      'package.json version === "0.1.0"（契约 §1 冻结值）',
      version === PKG_VERSION ? 'PASS' : 'FAIL',
      [`version 实际=${JSON.stringify(version)}，契约 §1 冻结值=${JSON.stringify(PKG_VERSION)}`],
    )

    // ── X4：契约 §1 冻结包名（验收清单 C1 只要求 name "存在"，这里补上值校验） ──
    report(
      'X4',
      'package.json name === "dsh-fingerprint"（契约 §1 冻结值）',
      pkg.name === PKG_NAME ? 'PASS' : 'FAIL',
      [
        `name 实际=${JSON.stringify(pkg.name)}，契约 §1 冻结值=${JSON.stringify(PKG_NAME)}`,
        '[note] 该值同时是 insert 的 name、panellist id / main key，以及 profile 依赖与 bundles 的键，写错会连带 C6/C8/C9 一起失配。',
      ],
    )
  }

  // ── C6：cordis.patch.yml 的 insert 行 ───────────────────────────────
  if (!existsSync(patchPath)) {
    report('C6', 'cordis.patch.yml 含 - insert: 且 id==="fingerprint" / name==="dsh-fingerprint"（契约 §1）', 'SKIP', [
      `文件不存在: ${patchPath}`,
      '[SKIP 理由] patch 文件尚未产出。若 C2 已声明 dsh.bundle.patch，则由 C2 报 FAIL，同一根因不重复计数。',
    ])
  } else {
    const read = readText(patchPath)
    if (!read.ok) {
      report('C6', 'cordis.patch.yml 含 - insert: 且 id==="fingerprint" / name==="dsh-fingerprint"（契约 §1）', 'FAIL', [
        `路径: ${patchPath}`,
        `读取失败: ${read.error}`,
      ])
    } else {
      const items = scanInsertItems(read.text)
      const hit = items.find((item) => item.name === PKG_NAME && item.id === INSERT_ID)
      const evidence = [
        `路径: ${patchPath}`,
        `扫描到 ${items.length} 个 insert 列表项: ${items.map((item) => `{id:${JSON.stringify(item.id)}, name:${JSON.stringify(item.name)}}@L${item.line}`).join(' ')}`,
      ]
      if (hit === undefined) {
        const sameName = items.filter((item) => item.name === PKG_NAME)
        const sameId = items.filter((item) => item.id === INSERT_ID)
        evidence.push(
          `未找到同时满足 id===${JSON.stringify(INSERT_ID)} 且 name===${JSON.stringify(PKG_NAME)} 的项。`,
          `仅 name 匹配 ${sameName.length} 项，仅 id 匹配 ${sameId.length} 项。`,
        )
        report('C6', 'cordis.patch.yml 含 - insert: 且 id==="fingerprint" / name==="dsh-fingerprint"（契约 §1）', 'FAIL', evidence)
      } else {
        evidence.push(`命中 @L${hit.line}: - id: ${hit.id} / name: ${hit.name}`)
        report('C6', 'cordis.patch.yml 含 - insert: 且 id==="fingerprint" / name==="dsh-fingerprint"（契约 §1）', 'PASS', evidence)
      }
    }
  }

  // ── C7 / X5 / X6：**发布就绪性**（发布语义 —— 与本地开发期的 C7 相反）──────
  // 本地开发：刻意不声明 engines.dsh（避免不兼容时被宿主静默 skip）。
  // 发布：必须声明 engines.dsh 且覆盖运行时，并带 license、不带 private:true。
  if (pkg === null) {
    for (const [id, title] of [
      ['C7', MANIFEST_TITLES.C7],
      ['X5', MANIFEST_TITLES.X5],
      ['X6', MANIFEST_TITLES.X6],
    ]) {
      report(id, title, 'SKIP', [`package.json 不可用: ${pkgReadError ?? '未知原因'}`])
    }
  } else {
    for (const entry of judgeManifest(pkg, RUNTIME).entries) {
      report(entry.id, entry.title, entry.status, entry.evidence)
    }
  }

  // ── C14：插件目录内不该有宿主包 ─────────────────────────────────────
  {
    const forbidden = join(PLUGIN_DIR, 'node_modules', '@deepseek-ai')
    const exists = existsSync(forbidden)
    const evidence = [`路径: ${forbidden}`]
    if (exists) {
      let listing = '(无法列举)'
      try {
        listing = readdirSync(forbidden).join(', ')
      } catch {
        /* 忽略 */
      }
      evidence.push('存在 ✘ —— 插件目录不该自带宿主包（会让模块解析出现第二份 @deepseek-ai/* 副本）。', `内容: ${listing}`)
    } else {
      evidence.push('不存在 ✔')
      const nodeModules = join(PLUGIN_DIR, 'node_modules')
      if (existsSync(nodeModules)) {
        try {
          evidence.push(`[info] node_modules 顶层: ${readdirSync(nodeModules).join(', ')}`)
        } catch {
          /* 忽略 */
        }
      }
    }
    report('C14', '插件目录内不存在 node_modules/@deepseek-ai', exists ? 'FAIL' : 'PASS', evidence)
  }

  // ── X2：依赖洁癖（契约 §8） ─────────────────────────────────────────
  {
    const nodeModules = join(PLUGIN_DIR, 'node_modules')
    const evidence = [`路径: ${nodeModules}`]
    let status = 'PASS'
    if (!existsSync(nodeModules)) {
      status = 'SKIP'
      evidence.push('node_modules 尚不存在（可能依赖还没装）—— 不算 FAIL。')
    } else {
      const entries = readdirSync(nodeModules).filter((name) => name !== '.package-lock.json' && !name.startsWith('.'))
      const extra = entries.filter((name) => name !== 'lmfpd-sdk')
      evidence.push(`顶层条目: ${entries.length === 0 ? '(空)' : entries.join(', ')}`)
      if (extra.length > 0) {
        status = 'FAIL'
        evidence.push(`超出契约 §8「不引入除 lmfpd-sdk 外的任何新依赖」: ${extra.join(', ')}`)
      } else {
        evidence.push('只含 lmfpd-sdk ✔（契约 §8）')
      }
    }
    report('X2', '插件目录 node_modules 顶层只含 lmfpd-sdk（契约 §8）', status, evidence)
  }

  // ── C13：宿主半侧入口 ───────────────────────────────────────────────
  if (!existsSync(hostEntryPath)) {
    report('C13', 'lib/index.js 存在且含 export function apply', 'SKIP', [`文件不存在: ${hostEntryPath}`])
  } else {
    const read = readText(hostEntryPath)
    if (!read.ok) {
      report('C13', 'lib/index.js 存在且含 export function apply', 'FAIL', [`路径: ${hostEntryPath}`, `读取失败: ${read.error}`])
    } else {
      const text = read.text
      const codeText = stripComments(text)
      const literal = /export\s+function\s+apply\b/u.test(codeText)
      const tolerant = /export\s+(?:async\s+)?function\s+apply\b|export\s+const\s+apply\s*=/u.test(codeText)
      const evidence = [
        `路径: ${hostEntryPath}`,
        `字节数: ${Buffer.byteLength(text, 'utf8')}`,
        '[note] 在剥离注释后的代码视图上判定（注释里提到 `export function apply` 不算命中）。',
      ]
      if (literal) {
        evidence.push('命中字面形式 `export function apply` ✔')
        report('C13', 'lib/index.js 存在且含 export function apply', 'PASS', evidence)
      } else if (tolerant) {
        evidence.push('[note] 未命中字面 `export function apply`，但命中等价导出形式（async function / const apply =）。')
        report('C13', 'lib/index.js 存在且含 export function apply', 'PASS', evidence)
      } else {
        evidence.push('未找到 apply 的 ESM 导出（查找 export function / export async function / export const apply =）。')
        report('C13', 'lib/index.js 存在且含 export function apply', 'FAIL', evidence)
      }
    }
  }

  // ── C8：profile 内的 junction/symlink ──────────────────────────────
  /**
   * C8 / C9 按契约 §1 冻结名锚定。若有人把本检查器指向别的插件目录（交叉验伪），
   * 这两项的结论对该包没有意义，这里显式说明，避免误读。
   */
  const foreignNameNote = pkg !== null && pkg.name !== PKG_NAME
    ? `[note] C8/C9 按契约 §1 冻结名 ${PKG_NAME} 锚定；当前包名是 ${JSON.stringify(pkg.name)}，两项结论不适用于该包。`
    : null
  if (!existsSync(LINK_PATH)) {
    report('C8', 'profile 内 node_modules/dsh-fingerprint 是 junction/symlink 且指向插件目录', 'SKIP', [
      `路径不存在: ${LINK_PATH}`,
      '（装载尚未手装，或指向被删）',
      ...(foreignNameNote === null ? [] : [foreignNameNote]),
    ])
  } else {
    const evidence = [`路径: ${LINK_PATH}`]
    if (foreignNameNote !== null) evidence.push(foreignNameNote)
    let status = 'PASS'
    let info = null
    try {
      info = lstatSync(LINK_PATH)
    } catch (error) {
      status = 'FAIL'
      evidence.push(`lstat 失败: ${String(error.message)}`)
    }
    if (info !== null) {
      if (!info.isSymbolicLink()) {
        status = 'FAIL'
        evidence.push('不是符号链接/junction（可能被 pnpm 实体化成了真实目录）✘')
      } else {
        let rawTarget = '(读取失败)'
        try {
          rawTarget = readlinkSync(LINK_PATH)
        } catch (error) {
          evidence.push(`readlink 失败: ${String(error.message)}`)
        }
        evidence.push(`链接目标(原样): ${rawTarget}`)
        let isDir = false
        try {
          isDir = statSync(LINK_PATH).isDirectory()
        } catch {
          /* 目标可能不存在 */
        }
        if (!isDir) {
          status = 'FAIL'
          evidence.push('链接目标不是可访问的目录 ✘（目标可能已被删除）')
        }
        const points = samePath(LINK_PATH, PLUGIN_DIR)
        evidence.push(`解析后与插件目录一致: ${points ? '是 ✔' : `否 ✘（期望 ${PLUGIN_DIR}）`}`)
        if (!points && status === 'PASS') status = 'FAIL'
      }
    }
    report('C8', 'profile 内 node_modules/dsh-fingerprint 是 junction/symlink 且指向插件目录', status, evidence)
  }

  // ── C9：profile package.json ───────────────────────────────────────
  {
    const evidence = [`路径: ${PROFILE_MANIFEST}`]
    if (foreignNameNote !== null) evidence.push(foreignNameNote)
    const read = readJson(PROFILE_MANIFEST)
    if (!read.ok) {
      report('C9', 'profile package.json：dependencies 为 link: 且 bundles 含 "dsh-fingerprint"', 'FAIL', [
        ...evidence,
        read.error,
      ])
    } else {
      const profile = read.value
      const dependency = profile.dependencies?.[PKG_NAME]
      const bundles = profile.dsh?.profile?.bundles
      let status = 'PASS'
      if (typeof dependency !== 'string' || dependency === '') {
        status = 'FAIL'
        evidence.push(`dependencies["${PKG_NAME}"] 缺失（实际 ${JSON.stringify(dependency)}）✘`)
      } else if (!dependency.startsWith('link:')) {
        status = 'FAIL'
        evidence.push(`dependencies["${PKG_NAME}"] = ${JSON.stringify(dependency)} —— 不是 link: 开头 ✘`)
      } else {
        evidence.push(`dependencies["${PKG_NAME}"] = ${JSON.stringify(dependency)} ✔`)
        const specPath = dependency.slice('link:'.length)
        const abs = /^[a-zA-Z]:[\\/]/u.test(specPath) ? specPath : resolve(PROFILE_DIR, specPath)
        evidence.push(`  link 目标解析: ${abs}（存在: ${existsSync(abs) ? '是 ✔' : '否 ✘'}）`)
        if (!existsSync(abs)) status = 'FAIL'
      }
      if (!Array.isArray(bundles)) {
        status = 'FAIL'
        evidence.push(`dsh.profile.bundles 不是数组（实际 ${JSON.stringify(bundles)}）✘`)
      } else if (!bundles.includes(PKG_NAME)) {
        status = 'FAIL'
        evidence.push(`dsh.profile.bundles 不含 ${JSON.stringify(PKG_NAME)} ✘`)
        evidence.push(`  现有 bundles: ${JSON.stringify(bundles)}`)
      } else {
        evidence.push(`dsh.profile.bundles 含 ${JSON.stringify(PKG_NAME)} @ 索引 ${bundles.indexOf(PKG_NAME)} ✔`)
      }
      evidence.push('[note] 两个条件需同时满足：进 bundles（否则 patch 不会被读）+ 有 dsh.bundle.patch（C2）。')
      report('C9', 'profile package.json：dependencies 为 link: 且 bundles 含 "dsh-fingerprint"', status, evidence)
    }
  }

  // ── C10 / C11 / C12 / X3：客户端束 ─────────────────────────────────
  if (!existsSync(resolvedClientPath)) {
    clientPending = true
    for (const [id, title] of [
      ['C10', 'client.js 不是 ESM（无顶层 import/export 语句，契约 §2.2）'],
      ['C11', 'client.js 含 window.__ModuleLoader__.load( 且含 exports.apply（契约 §2.2）'],
      ['C12', 'client.js 中每个 require("...") 实参 ∈ 11 个外壳种子词白名单（契约 §2.2）'],
      ['X3', 'client.js 含 exports.inject 或 inject =（契约 §2.2，cordis 服务名必需）'],
    ]) {
      report(id, title, 'SKIP', [
        `客户端束尚未产出: ${resolvedClientPath}`,
        `来源: ${resolvedClientOrigin}`,
        '[SKIP 理由] 文件尚未就绪（W6 并行落盘）；交付前必须转为 PASS。',
      ])
    }
  } else {
    const read = readText(resolvedClientPath)
    if (!read.ok) {
      for (const [id, title] of [
        ['C10', 'client.js 不是 ESM（无顶层 import/export 语句，契约 §2.2）'],
        ['C11', 'client.js 含 window.__ModuleLoader__.load( 且含 exports.apply（契约 §2.2）'],
        ['C12', 'client.js 中每个 require("...") 实参 ∈ 11 个外壳种子词白名单（契约 §2.2）'],
        ['X3', 'client.js 含 exports.inject 或 inject =（契约 §2.2，cordis 服务名必需）'],
      ]) {
        report(id, title, 'FAIL', [`路径: ${resolvedClientPath}`, `读取失败: ${read.error}`])
      }
    } else {
      const text = read.text
      // 标记类检查一律在"剥离注释后的代码视图"上做，避免注释里的字样造成假 PASS
      const codeText = stripComments(text)
      const sizeInfo = `字节数: ${Buffer.byteLength(text, 'utf8')}  行数: ${text.split(/\r?\n/u).length}`
      const codeViewNote = '[note] 本项在剥离注释后的代码视图上判定（注释里的字样不算命中）。'

      // C10：不得是 ESM
      {
        const pattern = /^\s*(import|export)\s/gu
        const hits = []
        const codeLines = codeText.split(/\r?\n/u)
        const rawLines = text.split(/\r?\n/u)
        for (let i = 0; i < codeLines.length; i += 1) {
          pattern.lastIndex = 0
          if (pattern.test(codeLines[i])) hits.push(`L${i + 1}: ${String(rawLines[i] ?? '').trim().slice(0, 100)}`)
        }
        const evidence = [
          `路径: ${resolvedClientPath}`,
          sizeInfo,
          '规则: 多行模式下在代码视图上匹配 /^\\s*(import|export)\\s/',
          codeViewNote,
        ]
        if (hits.length > 0) {
          evidence.push(`命中 ${hits.length} 处顶层 import/export ✘（契约 §2.2：必须 classic script）：`)
          for (const hit of hits.slice(0, 20)) evidence.push(`  ${hit}`)
          if (hits.length > 20) evidence.push(`  ...（其余 ${hits.length - 20} 处略）`)
          report('C10', 'client.js 不是 ESM（无顶层 import/export 语句，契约 §2.2）', 'FAIL', evidence)
        } else {
          evidence.push('未命中任何顶层 import/export 语句 ✔')
          report('C10', 'client.js 不是 ESM（无顶层 import/export 语句，契约 §2.2）', 'PASS', evidence)
        }
      }

      // C11：外壳包裹 + apply
      {
        const hasLoader = codeText.includes('window.__ModuleLoader__.load(')
        const hasApply = codeText.includes('exports.apply') || codeText.includes('apply =')
        const rawLoaderOnlyInComment = !hasLoader && text.includes('window.__ModuleLoader__.load(')
        const evidence = [
          `路径: ${resolvedClientPath}`,
          sizeInfo,
          codeViewNote,
          `window.__ModuleLoader__.load( : ${hasLoader ? '命中 ✔' : '未命中 ✘'}`,
          `exports.apply 或 apply = : ${hasApply ? '命中 ✔' : '未命中 ✘'}`,
        ]
        if (rawLoaderOnlyInComment) {
          evidence.push('⚠ 原文里有该字样，但只出现在注释中 —— 视为未命中（这正是本项剥离注释的原因）。')
        }
        report(
          'C11',
          'client.js 含 window.__ModuleLoader__.load( 且含 exports.apply（契约 §2.2）',
          hasLoader && hasApply ? 'PASS' : 'FAIL',
          evidence,
        )
      }

      // C12：require 实参白名单（关键检查）
      {
        const literals = collectRequireLiterals(codeText)
        const dynamic = collectRequireDynamic(codeText)
        const unique = [...new Set(literals)].sort()
        const illegal = unique.filter((name) => !SEED_MODULES.includes(name))
        const evidence = [
          `路径: ${resolvedClientPath}`,
          codeViewNote,
          `require() 调用共 ${literals.length} 次，去重后 ${unique.length} 个模块名:`,
        ]
        for (const name of unique) {
          evidence.push(`  ${SEED_MODULES.includes(name) ? '✔' : '✘'} require(${JSON.stringify(name)})`)
        }
        evidence.push(`白名单（${SEED_MODULES.length} 个）: ${SEED_MODULES.map((name) => JSON.stringify(name)).join(', ')}`)
        let status = 'PASS'
        if (illegal.length > 0) {
          status = 'FAIL'
          evidence.push(`越界模块名 ${illegal.length} 个 ✘（磁盘上不存在这些包，运行时会抛 module miss）:`)
          for (const name of illegal) evidence.push(`  ${JSON.stringify(name)}`)
        } else {
          evidence.push('全部 require 实参都在白名单内 ✔')
        }
        if (dynamic.length > 0) {
          status = 'FAIL'
          evidence.push(`发现 ${dynamic.length} 处非字面量 require，无法静态校验 ✘（契约 §2.2 只允许 11 个种子词的字面 require）:`)
          for (const item of dynamic.slice(0, 10)) evidence.push(`  require(${item}…)`)
        }
        report(
          'C12',
          'client.js 中每个 require("...") 实参 ∈ 11 个外壳种子词白名单（契约 §2.2）',
          status,
          evidence,
        )
      }

      // X3：cordis 服务名 inject（契约 §2.2 必需）
      {
        const hasInject = codeText.includes('exports.inject') || /\binject\s*=/u.test(codeText)
        const evidence = [
          `路径: ${resolvedClientPath}`,
          codeViewNote,
          `exports.inject 或 inject = : ${hasInject ? '命中 ✔' : '未命中 ✘'}`,
          '[note] 这条与 package.json 的 dsh.client.inject 是两回事：前者是 cordis 服务名（必需），后者是客户端图模块名（须省略，见 C3）。',
        ]
        report('X3', 'client.js 含 exports.inject 或 inject =（契约 §2.2，cordis 服务名必需）', hasInject ? 'PASS' : 'FAIL', evidence)
      }

      // ── S1–S6：槽位语义（契约 §1 / §2.1 / §12.9） ─────────────────────
      // 判定逻辑在 judgeSlots() 里，主流程与 --self-test 共用同一份实现（避免自测与真实检查漂移）。
      // 抽取失败一律 FAIL（不得 SKIP）—— 抽不出来就说明注册写错了。
      {
        const verdict = judgeSlots(codeText)
        for (const entry of verdict.entries) {
          report(entry.id, entry.title, entry.status, [
            `路径: ${resolvedClientPath}`,
            codeViewNote,
            verdict.shared.constNote,
            verdict.shared.regNote,
            ...entry.evidence,
          ])
        }
      }
    }
  }
}

// ── R1：回滚备件（与插件目录无关，故放在插件存在性分支之外，始终检查） ──────
//
// 为什么要有这一项：上一轮我把"备份不存在"当成**结论**写进 README，而它其实只是
// 一个**时间点采样**（该文件由 W1 在 05:16:08 创建，晚于我的探针）。
// 教训是：对别人拥有的文件，绝不能在交付物里硬编码"存在/不存在"，必须每次运行时现场判定。
// 现在这项既覆盖"当前是否存在"，也覆盖"真的缺失时是否 FAIL"。
{
  const title = `回滚备件存在：profile 的 ${ROLLBACK_BACKUP_NAME}（可回滚性）`
  const backupPath = join(PROFILE_DIR, ROLLBACK_BACKUP_NAME)
  const evidence = [`路径: ${backupPath}`, `依据: README「回滚」第 2 步 —— 它必须是一个可用的还原点。`]
  let status = 'FAIL'
  if (!existsSync(backupPath)) {
    evidence.push(`不存在 ✘ —— 回滚第 2 步只能靠手工删两行（依赖 + bundles 项）。`)
  } else {
    const info = statSync(backupPath)
    const read = readJson(backupPath)
    evidence.push(`存在 ✔  尺寸=${info.size} B  创建=${info.birthtime.toISOString()}  修改=${info.mtime.toISOString()}`)
    if (!read.ok) {
      evidence.push(`但内容不是可解析的 JSON ✘（${read.error}）—— 无法用它还原。`)
    } else if (typeof read.value !== 'object' || read.value === null || Array.isArray(read.value)) {
      evidence.push('但顶层不是 JSON 对象 ✘ —— 无法用它还原。')
    } else {
      status = 'PASS'
      const deps = read.value.dependencies ?? {}
      const hasSelf = Object.prototype.hasOwnProperty.call(deps, PKG_NAME)
      evidence.push(
        `[info] 快照形状: name=${JSON.stringify(read.value.name)}  dependencies=${Object.keys(deps).length} 项`,
        hasSelf
          ? `[info] 该快照已含 ${PKG_NAME} 依赖 —— 它不再是"装之前"的还原点，但文件本身合规。`
          : `[info] 该快照不含 ${PKG_NAME} 依赖 → 是一个真正的"装之前"还原点 ✔`,
      )
    }
  }
  report('R1', title, status, evidence)
}

// ─────────────────────────── 汇总 ───────────────────────────

const skipIds = results.filter((entry) => entry.status === 'SKIP').map((entry) => entry.id)
const summary = {
  pluginDir: PLUGIN_DIR,
  profileDir: PROFILE_DIR,
  clientBundle: resolvedClientPath,
  clientBundleResolvedFrom: resolvedClientOrigin,
  pass: passCount,
  fail: failCount,
  skip: skipCount,
  /** 待产出项（SKIP ≠ FAIL，但交付前必须全部转 PASS）。 */
  pending: skipIds,
  conclusion: failCount > 0 ? 'FAIL' : skipCount > 0 ? 'PENDING' : 'PASS',
  checks: results,
}

if (ARGS.json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
} else {
  process.stdout.write('\n──────────── 汇总 ────────────\n')
  process.stdout.write(`PASS ${passCount}   FAIL ${failCount}   SKIP ${skipCount}\n`)
  process.stdout.write(`客户端束路径（由 exports["./client"] 推导）: ${resolvedClientPath}\n`)
  process.stdout.write(`              来源: ${resolvedClientOrigin}\n`)
  if (failCount > 0) {
    process.stdout.write('未通过项（必须修）:\n')
    for (const item of results.filter((entry) => entry.status === 'FAIL')) {
      process.stdout.write(`  - ${item.id}  ${item.title}\n`)
    }
  }
  if (skipCount > 0) {
    process.stdout.write('待产出项（文件尚未就绪，不计 FAIL，但交付前必须转 PASS）:\n')
    for (const item of results.filter((entry) => entry.status === 'SKIP')) {
      process.stdout.write(`  - ${item.id}  ${item.title}\n`)
    }
  }
  const conclusion = failCount > 0
    ? 'FAIL（装载校验未通过）'
    : skipCount > 0
      ? `PENDING（无 FAIL，但有 ${skipCount} 项等待并行 worker 落盘；尚不可交付）`
      : 'PASS（逐项通过，可交付）'
  process.stdout.write(`结论: ${conclusion}\n`)
  process.stdout.write(`退出码: ${failCount > 0 ? 1 : 0}（按验收清单：只有 FAIL 影响退出码）\n`)
}

process.exit(failCount > 0 ? 1 : 0)
