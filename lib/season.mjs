/**
 * season.mjs —— DeepSeek 峰谷计费时段判定（宿主与客户端共用的唯一定义）
 *
 * 规则（官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing 脚注 (2)）：
 *   高峰时段 = 北京时间**周一至周五**（不含中国法定节假日）09:00–12:00、14:00–18:00
 *   其余时段 —— 包括周末、调休上班的周末、以及中国法定节假日全天 —— 一律空闲（谷价，半价）
 *
 * 生效分界线（历史分桶必须按当时规则计价，否则回放旧账会算错）：
 *   2026-08-17 峰谷定价正式实施
 *   2026-08-23 00:00（北京）起 周末全天谷价
 *   2026-09-19 00:00（北京）起 法定节假日全天谷价（含调休放假的工作日）
 *
 * ⚠️ 维护提示：每年 11 月国务院办公厅发布次年节假日安排后，补 `holidays.mjs`。
 *    本模块只关心"是否放假"；调休上班日全部落在周末，按周末规则本就是谷价，
 *    因此无需单列（holidays.mjs 里保留注释说明）。
 *
 * 本文件不含任何宿主专有 API，宿主半边直接 import，客户端半边由 build.mjs 内联。
 */

import { HOLIDAY_VALLEY, HOLIDAY_VALLEY_FROM_SEC, WEEKEND_VALLEY_FROM_SEC, COVERED_YEARS } from './holidays.mjs'

export { HOLIDAY_VALLEY, HOLIDAY_VALLEY_FROM_SEC, WEEKEND_VALLEY_FROM_SEC }

/**
 * 节假日表覆盖自检：当年或次年未覆盖时返回一条提醒文案，否则 null。
 *
 * 为什么不静默：缺次年日期不会报错，只会**静默地**把工作日假期误判成峰价（多算钱）。
 * 每年 11 月国务院发布次年安排后需要补 `holidays.mjs`。
 *
 * @param {Date} [at] 基准时刻，默认当前。
 * @returns {string|null}
 */
export function holidayCoverageWarning(at = new Date()) {
  const thisYear = String(new Date(at.getTime() + BEIJING_OFFSET_MS).getUTCFullYear())
  const nextYear = String(Number(thisYear) + 1)
  const missing = [thisYear, nextYear].filter((y) => !COVERED_YEARS.includes(y))
  if (missing.length === 0) return null
  return `节假日表缺少 ${missing.join('、')} 年的安排，工作日假期会被误判为峰价。`
    + `请每年 11 月国务院发布次年安排后补录 lib/holidays.mjs（已覆盖：${COVERED_YEARS.join('、')}）。`
}

/** 北京时间相对 UTC 的固定偏移（毫秒）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** 高峰时段（北京时间，分钟表示，左闭右开）。 */
export const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** 候选边界：北京当日 00:00 加上每个窗口边缘。 */
const BOUNDARY_MINUTES = [0, 9 * 60, 12 * 60, 14 * 60, 18 * 60]

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 北京日历日的 `YYYY-MM-DD` 键。 */
export function beijingDayKey(at) {
  const bj = new Date(at.getTime() + BEIJING_OFFSET_MS)
  return bj.toISOString().slice(0, 10)
}

/**
 * 宿主下发的节假日清单覆盖（前端用同一份源码复算时必须对齐宿主）。
 * 传 null 表示使用本模块内置的 holidays.mjs 表。
 * @type {Set<string>|null}
 */
let holidayOverride = null

/**
 * 用宿主下发的节假日清单覆盖内置表（前端专用）。
 * @param {string[]|null} days `YYYY-MM-DD` 数组，传 null 恢复内置表。
 */
export function setHolidays(days) {
  holidayOverride = Array.isArray(days) ? new Set(days) : null
}

/** 该北京日历日是否为放假日。 */
function holidaySetHas(dayKey) {
  if (holidayOverride !== null) return holidayOverride.has(dayKey)
  return Object.hasOwn(HOLIDAY_VALLEY, dayKey)
}

/**
 * 该时刻是否落在法定节假日（且该规则已生效）。
 * 生效日之前的历史时刻一律 false，保证旧账按当时的规则计价。
 */
export function isHolidayValley(at) {
  if (at.getTime() / 1000 < HOLIDAY_VALLEY_FROM_SEC) return false
  return holidaySetHas(beijingDayKey(at))
}

/**
 * 该时刻是否按"周末全天谷价"处理（且该规则已生效）。
 */
export function isWeekendValley(at) {
  if (at.getTime() / 1000 < WEEKEND_VALLEY_FROM_SEC) return false
  const dow = new Date(at.getTime() + BEIJING_OFFSET_MS).getUTCDay()
  return dow === 0 || dow === 6
}

/**
 * 判断某时刻是否为高峰时段（峰价）。
 *
 * @param {Date} [at] 待判定时刻，默认当前。
 * @returns {boolean}
 */
export function isPeak(at = new Date()) {
  if (isWeekendValley(at)) return false
  if (isHolidayValley(at)) return false
  const bj = new Date(at.getTime() + BEIJING_OFFSET_MS)
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to)
}

/** 某个时刻所在北京日的 00:00（绝对时刻）。 */
function beijingMidnight(timeMs) {
  const bj = new Date(timeMs + BEIJING_OFFSET_MS)
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - BEIJING_OFFSET_MS
}

/**
 * 下一次真正发生峰↔谷切换的时刻。
 *
 * 候选边界取未来 12 天（最长春节假期 9 天，留足余量），且只接受**状态确实变化**的边界：
 * 周五 18:00 之后的下一个边界是周六 09:00，但整个周末本来就已是谷价，
 * 报它会显示一个并不会发生的倒计时，正确答案是周一 09:00。
 *
 * @param {Date} [at] 起算时刻。
 * @returns {number|null} 切换时刻（毫秒），12 天内无切换则为 null。
 */
export function nextFlip(at = new Date()) {
  const from = at.getTime()
  const midnight = beijingMidnight(from)
  const candidates = []
  for (let day = 0; day <= 12; day += 1) {
    const base = midnight + day * DAY_MS
    for (const minutes of BOUNDARY_MINUTES) candidates.push(base + minutes * 60 * 1000)
  }
  candidates.sort((a, b) => a - b)
  for (const candidate of candidates) {
    if (candidate <= from) continue
    if (isPeak(new Date(candidate)) !== isPeak(new Date(candidate - 1))) return candidate
  }
  return null
}

/** 剩余时长的紧凑写法：`2h13m`、`45m`、`38s`。 */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

/** 北京时间的星期名与 HH:MM。 */
export function beijingClock(at = new Date()) {
  const bj = new Date(at.getTime() + BEIJING_OFFSET_MS)
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const hh = String(bj.getUTCHours()).padStart(2, '0')
  const mm = String(bj.getUTCMinutes()).padStart(2, '0')
  return { weekday: weekdays[bj.getUTCDay()], clock: `${hh}:${mm}`, dayKey: bj.toISOString().slice(0, 10) }
}

/** 该时刻是节假日、周末，还是普通工作日（用于面板上多给一行说明）。 */
export function dayKind(at = new Date()) {
  if (isHolidayValley(at)) return 'holiday'
  if (isWeekendValley(at)) return 'weekend'
  return 'weekday'
}

/**
 * 一次性描述某时刻的计费时段，供芯片与面板共用。
 *
 * @param {Date} [at]
 * @returns {{
 *   peak: boolean, label: string, compact: string, countdown: string,
 *   flipAt: number|null, remainingMs: number|null, nextLabel: string,
 *   color: string, title: string, kind: string,
 *   beijing: { weekday: string, clock: string, dayKey: string },
 *   holiday: boolean, weekend: boolean,
 * }}
 */
export function describePhase(at = new Date()) {
  const peak = isPeak(at)
  const flip = nextFlip(at)
  const remaining = flip === null ? null : flip - at.getTime()
  const countdown = remaining === null ? '' : formatCountdown(remaining)
  const kind = dayKind(at)
  const label = peak ? '高峰时段' : '空闲时段'
  const compact = peak ? '峰价' : '谷价'
  const nextLabel = peak ? '空闲时段' : '高峰时段'
  const reason = kind === 'holiday' ? '法定节假日全天谷价' : kind === 'weekend' ? '周末全天谷价' : ''
  return {
    peak,
    kind,
    holiday: kind === 'holiday',
    weekend: kind === 'weekend',
    label,
    compact,
    countdown,
    flipAt: flip,
    remainingMs: remaining,
    nextLabel,
    beijing: beijingClock(at),
    /** 两个状态色的唯一来源，芯片与面板共用。 */
    color: peak ? '#D9A24A' : '#57C07C',
    title: peak
      ? `当前为高峰计价（峰价），${countdown} 后转入空闲时段。北京时间 ${beijingClock(at).weekday} ${beijingClock(at).clock}。`
      : `当前为空闲计价（谷价，半价）${reason === '' ? '' : '，' + reason}，还剩 ${countdown}。北京时间 ${beijingClock(at).weekday} ${beijingClock(at).clock}。`,
  }
}
