/**
 * season.test.mjs —— 峰谷与节假日判定的单元测试
 *
 * 这类"日期边界"逻辑最容易错，而且错了不会报错、只会静默算错钱，
 * 所以每个规则都用真实日期钉住。
 *
 * 用法：node --test lib/season.test.mjs   （或直接 node lib/season.test.mjs）
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = path.dirname(fileURLToPath(import.meta.url))
const season = await import(pathToFileURL(path.join(LIB, 'season.mjs')).href)
const { isPeak, nextFlip, describePhase, isHolidayValley, isWeekendValley, holidayCoverageWarning } = season

/** 北京时间 → 绝对时刻（UTC+8）。 */
const bj = (y, m, d, hh = 0, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0))

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✓ ' + name)
  } catch (err) {
    failed++
    console.log('  ✗ ' + name)
    console.log('      ' + String(err.message).split('\n').join('\n      '))
  }
}

console.log('\n=== 普通工作日：高峰窗口 ===')

// 2026-10-01 是国庆假期，换一个普通工作日：2026-10-13 是周二
check('周二 08:59 谷价', () => assert.equal(isPeak(bj(2026, 10, 13, 8, 59)), false))
check('周二 09:00 峰价（窗口左闭）', () => assert.equal(isPeak(bj(2026, 10, 13, 9, 0)), true))
check('周二 11:59 峰价', () => assert.equal(isPeak(bj(2026, 10, 13, 11, 59)), true))
check('周二 12:00 谷价（窗口右开）', () => assert.equal(isPeak(bj(2026, 10, 13, 12, 0)), false))
check('周二 13:59 谷价', () => assert.equal(isPeak(bj(2026, 10, 13, 13, 59)), false))
check('周二 14:00 峰价', () => assert.equal(isPeak(bj(2026, 10, 13, 14, 0)), true))
check('周二 17:59 峰价', () => assert.equal(isPeak(bj(2026, 10, 13, 17, 59)), true))
check('周二 18:00 谷价', () => assert.equal(isPeak(bj(2026, 10, 13, 18, 0)), false))
check('周二 23:30 谷价', () => assert.equal(isPeak(bj(2026, 10, 13, 23, 30)), false))

console.log('\n=== 周末规则（2026-08-23 起生效） ===')

check('周六 10:00 谷价（2026-10-17）', () => assert.equal(isPeak(bj(2026, 10, 17, 10, 0)), false))
check('周日 15:00 谷价（2026-10-18）', () => assert.equal(isPeak(bj(2026, 10, 18, 15, 0)), false))
check('周末标记正确', () => assert.equal(isWeekendValley(bj(2026, 10, 17, 10, 0)), true))
check('生效前周末按工作日计价（2026-08-22 周六 10:00 应为峰价）', () =>
  assert.equal(isPeak(bj(2026, 8, 22, 10, 0)), true))

console.log('\n=== 法定节假日全谷价（2026-09-19 起生效） ===')

check('国庆 2026-10-01 10:00 谷价', () => assert.equal(isPeak(bj(2026, 10, 1, 10, 0)), false))
check('国庆 2026-10-07 15:00 谷价', () => assert.equal(isPeak(bj(2026, 10, 7, 15, 0)), false))
check('国庆被识别为节假日', () => assert.equal(isHolidayValley(bj(2026, 10, 3, 11, 0)), true))
check('春节 2026-02-17 10:00 —— 生效日前，仍按工作日计价（历史回放口径）', () =>
  assert.equal(isPeak(bj(2026, 2, 17, 10, 0)), true))
check('春节日期本身在表中', () => assert.equal(Object.hasOwn(season.HOLIDAY_VALLEY, '2026-02-17'), true))

console.log('\n=== 调休上班的周末仍在周末 → 谷价 ===')

// 2026-10-10（周六）是国庆调休上班日
check('2026-10-10 周六（调休上班）10:00 谷价', () => assert.equal(isPeak(bj(2026, 10, 10, 10, 0)), false))

console.log('\n=== 下一次切换点 ===')

check('周二 08:00 → 09:00', () => {
  const at = bj(2026, 10, 13, 8, 0)
  assert.equal(nextFlip(at), bj(2026, 10, 13, 9, 0).getTime())
})
check('周二 09:30 → 12:00', () => {
  const at = bj(2026, 10, 13, 9, 30)
  assert.equal(nextFlip(at), bj(2026, 10, 13, 12, 0).getTime())
})
check('周四 18:30 → 周五 09:00（跨夜，跳过谷价的夜间）', () => {
  const at = bj(2026, 10, 15, 18, 30) // 周四
  assert.equal(nextFlip(at), bj(2026, 10, 16, 9, 0).getTime())
})
check('周五 18:30 → 下周一 09:00（周末整段已谷价，不该报周六 09:00）', () => {
  const at = bj(2026, 10, 16, 18, 30) // 周五
  assert.equal(nextFlip(at), bj(2026, 10, 19, 9, 0).getTime())
})
check('国庆假期中（2026-10-03 10:00）→ 假期结束后首个工作日 09:00', () => {
  const at = bj(2026, 10, 3, 10, 0)
  const flip = nextFlip(at)
  // 10/8 是周四，假期后的第一个工作日
  assert.equal(flip, bj(2026, 10, 8, 9, 0).getTime())
})

console.log('\n=== describePhase 输出 ===')

check('峰价档位文案', () => {
  const p = describePhase(bj(2026, 10, 13, 10, 0))
  assert.equal(p.peak, true)
  assert.equal(p.compact, '峰价')
  assert.equal(p.label, '高峰时段')
  assert.equal(p.nextLabel, '空闲时段')
})
check('谷价档位文案（周末）', () => {
  const p = describePhase(bj(2026, 10, 17, 10, 0))
  assert.equal(p.peak, false)
  assert.equal(p.compact, '谷价')
  assert.equal(p.kind, 'weekend')
  assert.equal(p.weekend, true)
})
check('节假日标记与提示语', () => {
  const p = describePhase(bj(2026, 10, 3, 10, 0))
  assert.equal(p.holiday, true)
  assert.equal(p.kind, 'holiday')
  assert.ok(p.title.includes('法定节假日'), '提示语应说明节假日：' + p.title)
})
check('北京时间读数', () => {
  const p = describePhase(bj(2026, 10, 13, 10, 30))
  assert.equal(p.beijing.weekday, '周二')
  assert.equal(p.beijing.clock, '10:30')
  assert.equal(p.beijing.dayKey, '2026-10-13')
})

console.log('\n=== 覆盖自检 ===')

check('holidayCoverageWarning 返回提醒（缺 2027）', () => {
  const w = holidayCoverageWarning()
  assert.ok(w === null || typeof w === 'string')
  if (w !== null) assert.ok(w.includes('节假日表缺少'), w)
})

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败\n')
process.exit(failed === 0 ? 0 : 1)
