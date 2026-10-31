/**
 * client.smoke.mjs —— 浏览器半边的冒烟测试（不进 npm 包，开发用）
 *
 * 浏览器半边是 `window.__ModuleLoader__.load({ factory })` 形式的普通脚本，
 * Node 里没有 window / React。这里用最小的桩把它"装起来"，只验证：
 *   · factory 能无异常执行完，并导出 apply / inject
 *   · 纯函数（金额格式、面板行、账本差值）行为正确
 * 真正的渲染仍由宿主页面负责，这里不做 React 渲染。
 *
 * 用法：node client.smoke.mjs
 */
import assert from 'node:assert/strict'

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}

/** 最小 React 桩：只够 factory 顶层跑通，不参与渲染。 */
const reactStub = {
  createElement: () => null,
  Fragment: Symbol('Fragment'),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  memo: (fn) => fn,
}
const reactDomStub = { createPortal: (node) => node }

const storage = new Map()
globalThis.window.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
}
globalThis.document = { hidden: false }

await import('./lib/client.js')

assert.ok(captured !== null, 'window.__ModuleLoader__.load 没有被调用')
assert.equal(captured.id, 'dsh-tide-badge')

const mod = captured.factory((name) => {
  if (name === 'react') return reactStub
  if (name === 'react-dom') return reactDomStub
  throw new Error('unexpected module: ' + name)
})

assert.equal(typeof mod.apply, 'function')
assert.deepEqual(mod.inject, ['slots'])

const t = mod.__internal
assert.equal(typeof t.formatMoney, 'function')
assert.equal(t.formatMoney(0, 'CNY'), '0¥')
assert.equal(t.formatMoney(9.2, 'CNY'), '9.2¥')
assert.equal(t.formatMoney(0.1234, 'CNY'), '0.1234¥')
assert.equal(t.formatMoney(1.5, 'USD'), '1.5$')
assert.equal(t.formatMoney(undefined, 'CNY'), '--')

// 面板行：宿主的完整状态
const rows = t.panelRows({
  season: {
    peak: false,
    holiday: false,
    weekend: false,
    countdown: '8m',
    flipAt: Date.now() + 8 * 60 * 1000,
    beijing: { weekday: '周五', clock: '08:51' },
  },
  balance: { ok: true, source: 'account', currency: 'CNY', total: 9.2, granted: 0, toppedUp: 9.2 },
})
const keys = rows.map((r) => r.key)
assert.deepEqual(keys, ['计费时段', '下次切换', '北京时间', '账户余额'])
assert.equal(rows[0].value, '空闲时段（谷价，半价）')
assert.ok(rows[1].value.startsWith('8m后'))

// 节假日标记
const holidayRows = t.panelRows({
  season: { peak: false, holiday: true, weekend: false, countdown: '', flipAt: null, beijing: { weekday: '周四', clock: '10:00' } },
  balance: null,
})
assert.equal(holidayRows[0].value, '空闲时段（谷价，半价）（法定节假日）')
assert.equal(holidayRows[1].value, '--')

// 余额两条路都失败时，脚注把原因摊开
assert.equal(
  t.panelNote({ ok: false, error: 'HTTP 401', accountReason: '账号未登录' }),
  '账号路：账号未登录；API Key 路：HTTP 401',
)
assert.equal(t.panelNote({ ok: true, source: 'account' }), '余额来自桌面端账号登录态')
assert.equal(t.panelNote({ ok: true, source: 'key' }), '余额来自 API Key')

// 账本：首见播种基准 → 余额下降记花费 → 余额上升不记负
t.observeBalance('s1', 10)
assert.equal(t.sessionCostOf('s1'), 0)
t.observeBalance('s1', 9.5)
assert.equal(t.sessionCostOf('s1').toFixed(2), '0.50')
t.observeBalance('s1', 20) // 充值
assert.equal(t.sessionCostOf('s1').toFixed(2), '0.50')
t.observeBalance('s1', 19.9)
assert.equal(t.sessionCostOf('s1').toFixed(2), '0.60')
// 账本按对话分开
assert.equal(t.sessionCostOf('s2'), 0)

console.log('client.smoke: 全部通过')
