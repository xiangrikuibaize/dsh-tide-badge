# dsh-tide-badge

DSH 输入框下方的**计费时段与余额**药丸：显示当前是**峰价**还是**谷价**、距离下次切换还有多久，点开看完整读数与账户余额。

融合了两个插件的长处：

| 来源 | 采纳的部分 |
|---|---|
| [`dsh-billing-badge`](https://github.com/devacc8/dsh-billing-badge)（MIT） | UI 形态：挂在原生统计行（"缓存命中"那一排）的小药丸、点击展开的面板与布局、原生样式变量 |
| [`dsh-whale-widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT） | 余额取数（桌面端账号登录态优先、API Key 兜底）与**中国法定节假日**适配、峰谷生效分界线 |

两者的代码均为 MIT 许可，本项目在其基础上重写与合并；节气/节假日逻辑按官方计费规则重新实现并加了单元测试。感谢两位作者。

## 显示位置

输入框下方统计行里、紧跟原生"**缓存命中**"药丸之后的一枚小圆点药丸：

- **峰价 · 2h13m** / **谷价 · 45m**
- 圆点颜色：峰价橙色、谷价绿色
- 点击展开面板：计费时段（含"法定节假日"/"周末"标记）、下次切换、北京时间、账户余额（余额/赠送/充值明细）

## 计费规则（判定依据）

官方 [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 脚注 (2)：

> 北京时间**周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00** 为高峰时段；
> 其余时段，包括**周末及中国法定节假日全天**均为空闲时段。
> 空闲时段价格为高峰时段价格的一半。

历史回放按当时规则计价，因此带生效分界线：

| 规则 | 生效时刻（北京） |
|---|---|
| 峰谷定价实施 | 2026-08-17 00:00 |
| 周末全天谷价 | 2026-08-23 00:00 |
| 法定节假日全天谷价 | 2026-09-19 00:00 |

## 余额从哪来

两条路，**账号优先**：

1. **桌面端账号登录态** —— 走 DSH 自己的 `deepseekAccount` 服务。官方 `/user/balance` 只认 `sk-` 开头的 API Key，而桌面端登录用的是 OAuth 授权，所以登录用户必须走这条路。面板底部会注明"余额来自桌面端账号登录态"。
2. **API Key** —— `DEEPSEEK_API_KEY`（DSH 凭据或环境变量）→ `GET /user/balance`。账号路不可用时才走，作为兜底。

**失败时不留白。** 两条路互不通气时，面板底部会把各自的原因分别摊开（`账号路：…；API Key 路：…`），而不是笼统一句"未配置"。账号路区分这些情况：服务不存在 / 未登录 / 平台查询失败（登录态可能过期）/ 没有余额钱包 / 钱包数据无法解析。

> 为什么账号优先：若凭据里残留一个**无效**的 API Key，密钥路的失败会掩盖本该成功的账号路（本机就踩过：一个 32 位十六进制串导致长期 401）。

API Key 不出宿主进程，浏览器只拿到余额数字。失败一律降级成面板上一行文案，不抛出。

### 为什么账号路带重试

余额查询打的是 `platform.deepseek.com`，而**推理**打的是 `api.deepseek.com` ——两个域，两条网络路径。装了会做 HTTPS 解密的杀软（如 Kaspersky）时，`platform` 域会**间歇性** TLS 失败：解密连接插入自签根证书，Node 的 undici 只认自带 CA 列表、不读 Windows 证书库，于是报 `SELF_SIGNED_CERT_IN_CHAIN`。

本机实测约 **3/8 概率失败**，且是随机的 —— 所以 `readAccountBalance` 带 3 次重试，单次失败不影响最终结果。

若要根治，可让 Node 信任杀软根证书（会信任链多一环，属常规权衡）：

```powershell
# 1) 导出根证书为 PEM，2) 指向它
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', '<根证书.pem 的绝对路径>', 'User')
```

设置后重启 DSH。本机实测该方案 8/8 成功。

## ⚠️ 年度维护：节假日表

`lib/holidays.mjs` 是**唯一需要每年更新**的文件。国务院办公厅通常每年 11 月发布次年安排，届时补录 `HOLIDAY_VALLEY`。

**只列放假的日期**：调休上班日全部落在周末，按"周末也是谷价"的规则本就是谷价，无需单列。

漏录不会报错，只会**静默地**把工作日假期误判成峰价（多算钱）。插件启动时会自检并在日志里提醒缺少哪一年。

当前覆盖：**2026 年**。

## 架构

```
lib/
  holidays.mjs        节假日表 + 三条生效分界线（年度维护点）
  season.mjs          峰谷判定、下一次切换、文案与颜色（两端共用）
  season.test.mjs     单元测试（29 项，覆盖窗口边界/生效线/切换点）
  index.js            宿主半边：/plugins/tide-badge/state 只读路由
  build.mjs           把 season/holidays 内联进客户端
  client.js           由 build.mjs 生成，勿手改
client.template.js    客户端模板
cordis.patch.yml      bundle 组装补丁
```

**两端同源**：浏览器半边是由宿主注入的普通脚本，其 `require` 不认识相对路径 import，所以 `build.mjs` 把 `season.mjs` 与 `holidays.mjs` 内联进 `client.js`。节假日清单也由宿主通过路由下发，前端用同一份源码复算 —— 保证两端算出的切换点完全一致。

## 开发

```bash
node lib/build.mjs          # 改完 season/holidays 后重新内联客户端
node lib/season.test.mjs    # 跑单元测试
node --check lib/client.js  # 语法校验
```

改完需**重启 DSH** 才生效（宿主半边在启动时装配）。
