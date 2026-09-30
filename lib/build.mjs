/**
 * build.mjs —— 把 lib/holidays.mjs 与 lib/season.mjs 内联进客户端半边。
 *
 * 为什么内联而不是运行时 import：浏览器半边是由宿主以
 * `window.__ModuleLoader__.load({ factory: (require) => ... })` 注入的一段普通
 * 脚本，它的 `require` 只认识宿主暴露的模块（react 等），不认识相对路径 import。
 * 内联保证**前端与宿主跑同一份时段/节假日判定源码**，节假日只有一处需要维护。
 *
 * 用法：node lib/build.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.dirname(LIB)

const TEMPLATE = path.join(PKG, 'client.template.js')
const OUT = path.join(LIB, 'client.js')

/**
 * 把一个 ES 模块源码转成可直接内联的普通脚本片段。
 *
 * 需要处理四类语句（import/export 都可能跨多行）：
 *   1. `import ... from './x.mjs'`      → 删除（内联后同一个作用域，不需要导入）
 *   2. `import { a, b } from './x.mjs'` → 删除（跨行）
 *   3. `export { a, b }`                → 删除（跨行）
 *   4. `export { a, b } from './x.mjs'` → 删除（跨行）
 *   5. `export const/function/...`      → 去掉 `export ` 前缀
 *
 * @param {string} src 模块源码
 * @returns {string} 可内联的片段
 */
function toInlineFragment(src) {
  const out = []
  const lines = src.split('\n')
  // 跳过跨行语句时用的状态：'import' | 'exportList' | null
  let skipping = null

  for (const line of lines) {
    const trimmed = line.trim()

    if (skipping !== null) {
      // 直到遇到语句结束的分号或右花括号
      if (trimmed.endsWith(';') || trimmed.endsWith('}')) skipping = null
      continue
    }

    // 1) 单行 import
    if (/^import\s.+from\s+['"]\.\//.test(trimmed)) continue
    if (/^import\s+['"]\.\//.test(trimmed)) continue

    // 2) 跨行 import
    if (/^import\s*\{[^}]*$/.test(trimmed)) {
      skipping = 'import'
      continue
    }

    // 3) `export { ... }` / `export { ... } from '...'`
    if (/^export\s*\{/.test(trimmed)) {
      if (!(trimmed.endsWith(';') || trimmed.endsWith('}'))) skipping = 'exportList'
      continue
    }

    // 4) 单行 `export { ... };`
    if (/^export\s*\{[^}]*\}\s*(from\s+['"][^'"]+['"])?;?\s*$/.test(trimmed)) continue

    // 5) 去掉声明前的 export 前缀
    out.push(line.replace(/^(\s*)export\s+(const|let|var|function|class|async)\s/, '$1$2 '))
  }

  return out.join('\n')
}

/** 组装客户端文件。 */
function build() {
  const template = fs.readFileSync(TEMPLATE, 'utf8')
  const holidays = toInlineFragment(fs.readFileSync(path.join(LIB, 'holidays.mjs'), 'utf8'))
  const season = toInlineFragment(fs.readFileSync(path.join(LIB, 'season.mjs'), 'utf8'))

  const inline = [
    '/* ===== 以下由 build.mjs 从 lib/holidays.mjs 与 lib/season.mjs 内联，请勿手改 ===== */',
    holidays,
    '',
    season,
    '/* ===== 内联结束 ===== */',
  ].join('\n')

  if (!template.includes('/* SEASON_INLINE */')) {
    console.error('模板里找不到 /* SEASON_INLINE */ 标记')
    process.exit(1)
  }
  const out = template.replace('/* SEASON_INLINE */', inline)
  fs.writeFileSync(OUT, out, 'utf8')

  // 内联后不应残留任何 import/export 关键字
  const residual = out.split('\n')
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => /^\s*(import|export)\s/.test(l))
  console.log('已生成 ' + OUT)
  console.log('  字节数: ' + Buffer.byteLength(out, 'utf8'))
  console.log('  残留 import/export 行数: ' + residual.length)
  if (residual.length > 0) {
    for (const r of residual.slice(0, 8)) console.log('    第 ' + r.i + ' 行: ' + r.l.trim().slice(0, 90))
    process.exit(1)
  }
  console.log('  含 HOLIDAY_VALLEY: ' + out.includes('HOLIDAY_VALLEY'))
  console.log('  含 describePhase : ' + out.includes('function describePhase'))
  console.log('  含 setHolidays   : ' + out.includes('function setHolidays'))
}

build()
