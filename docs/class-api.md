# 班级只读查询 API（class-api） v1

> 2026-10-05 上线。供班级侧系统按班查询本班幼儿的手环健康数据与体测数据。
> 实现：`routes/class-api.js`（在 `server.js` 中 `mountClassApiRoutes(app)` 挂载）。
> 迁移：`sql/class-api-20261005.sql`（仅新建 `class_api_keys` / `class_api_logs` 两张表）。

## 1. 基础约定

- **Base URL**：`https://jiangxiyey.cn/api/class/v1`（公网唯一入口，HTTPS；平台经 Caddy 反代到 118 内网 3070）
- 118.31.173.184:3070 公网**不可直连**（防火墙拦截），必须走域名。班级侧系统在外网即可直接调用。
- **方法**：全部 `GET`（只读；POST 会被 CSRF 中间件拦截）
- **鉴权**：请求头 `X-API-Key: <key>`（备用：`Authorization: Bearer <key>`）
- **统一响应**：成功 `{"code":0,"data":{...}}`；失败 `{"code":1,"msg":"..."}`
- **班级范围**：请求方**不需要也不允许**传 `class_id`；服务端一律从 API Key 绑定的班级派生。任何越权访问本班以外数据都会返回 403。
- **响应条数上限**：`fitness` 默认 200、最大 500（`limit`）；`child` 明细查询跨度上限 31 天。

### 状态码

| 状态码 | 含义 |
|---|---|
| 200 | 成功 |
| 400 | 参数错误（日期非法、跨度超限等） |
| 401 | 缺少 / 无效 API Key |
| 403 | Key 已停用、未绑班，或越权访问非本班幼儿 |
| 429 | 触发限流（per-key 120 次/分钟） |
| 500 | 服务内部错误 |

### 限流

每把 Key 独立限流：**120 请求 / 60 秒**。响应头带 `RateLimit-*`（Policy/Limit/Remaining/Reset）。超限返回 `429 {"code":1,"msg":"请求过于频繁，请稍后再试"}`。

### 隐私与脱敏（红线）

- 幼儿姓名**一律脱敏**（复用平台 `lib/name-masking.js`）：默认末字打星 `付博静→付博*`，同班撞名改中间星 `朱瑾瑜→朱*瑜`。
- **绝不输出** `guardian_phone` / `guardian_name` / `notes` / `attention_*` 等隐私字段。
- 审计表 `class_api_logs` 记录每次调用（key_id / class_id / endpoint / params / ip / status / duration_ms / created_at）。

### 日期参数说明

- 所有日期均为 **`YYYY-MM-DD`**（服务器本地时区 Asia/Shanghai）。
- 非法日期（格式错、或 `2026-02-31` 这类不存在的日期）→ `400`。
- `date` 缺省 = 今天。
- `from` / `to` 缺省 = 不限；**只填一端**时另一端自动补 `date`（默认今天）。

### 数据口径（重要）

- **`steps` 是手环「当日累计」计数器**（每约 30s 上报同一累计值，零点归零）。因此：
  - 单人当日步数 = 当日 `MAX(steps)`；**绝不能对多行 SUM**（会放大约 3000 倍）。
  - 全班 `total_steps` = 本班各手环当日 `MAX(steps)` 之和。
- **`active_minutes`（运动时长）** = 本班各手环当日「步数计数**增加**」的上报条数 × 30s（用窗口函数 LAG 求增量，仅增量代表真实步数位移）。
- 健康指标过滤：心率取 `31–249`，体温取 `35–42℃`（与平台 `lib/band-jobs.js` 同口径），滤掉未佩戴/离腕/0 值噪声。
- 「有数据人数」= 当日至少有一条**有效读数**（心率/血氧/步数任一）的手环数。
- 放假 / 断网 / 未佩戴时数据为 0 属正常，端点会返回明确空态（`empty:true` + `empty_note`），不是系统故障。

---

## 2. 各班级 API Key（正式，妥善保管）

> 明文仅在本文件与交付报告中出现；数据库只存 sha256 哈希，不可反推。

| 班级 | class_id | API Key |
|---|---|---|
| 大三班 | 6 | `xyjk_<REDACTED-SEE-SERVER>` |
| 大五班 | 4 | `xyjk_<REDACTED-SEE-SERVER>` |
| 中一班 | 8 | `xyjk_<REDACTED-SEE-SERVER>` |
| 中四班 | 11 | `xyjk_<REDACTED-SEE-SERVER>` |

停用某把 Key：`UPDATE class_api_keys SET enabled=0 WHERE class_id=<id>;`

---

## 3. 端点

### 3.1 `GET /summary` — 本班当日汇总

参数：`date`（可选，默认今天）

```json
{
  "code": 0,
  "data": {
    "class": {"id": 6, "name": "大三班", "grade_level": "large"},
    "date": "2026-09-29",
    "children_total": 29,
    "band_bound": 29,
    "children_with_data": 26,
    "children_no_data": 3,
    "total_steps": 7912,
    "avg_heart_rate": 87.1,
    "avg_spo2": 97,
    "avg_body_temp": 36.5,
    "max_heart_rate": 113,
    "active_minutes": 192,
    "empty": false,
    "empty_note": null,
    "steps_note": "steps 为手环当日累计计数，total_steps=各班内手环当日 MAX(steps) 之和",
    "active_note": "运动时长=本班各手环当日步数计数「增加」的上报条数×30s"
  }
}
```

### 3.2 `GET /children` — 脱敏名单 + 当日手环 + 最新体测

参数：`date`（可选，默认今天）

```json
{
  "code": 0,
  "data": {
    "class": {"id": 8, "name": "中一班"},
    "date": "2026-09-30",
    "count": 25,
    "children": [
      {
        "child_id": 428,
        "name": "过亦*",
        "gender": "男",
        "band_mac": "d612d9003e6c",
        "band": {
          "steps": 0, "avg_heart_rate": null, "max_heart_rate": 0,
          "avg_spo2": null, "avg_body_temp": null, "battery": 36,
          "last_report_at": "2026-09-30 23:59:41", "records": 2880
        },
        "latest_fitness": {
          "test_date": "2026-05-25 00:00:00",
          "height_cm": 106.8, "weight_kg": 21.5, "bmi": 18.8,
          "rating": "合格", "total_score": 60.3
        }
      }
    ]
  }
}
```

`band` 为 `null` 表示该幼儿无手环或当日无有效读数；`latest_fitness` 为 `null` 表示无体测记录。

### 3.3 `GET /child/:id` — 单孩详情（限本班）

参数：`id`（路径，children.id）；`date`（默认今天）；`from` / `to`（区间，跨度 ≤31 天）；`bucketMin`（时段桶分钟，5–240，默认 30，仅单日时输出时段桶）

- 非本班幼儿 → `403`。
- `from`/`to` 跨多日时只返回**按日聚合** `band_daily`；单日窗口额外返回 `band_segments`（按时段）。

```json
{
  "code": 0,
  "data": {
    "child": {"id": 290, "name": "朱翊*", "gender": "女", "class_id": 6, "class_name": "大三班"},
    "band_mac": "d612d9003336",
    "date": "2026-09-29",
    "range": {"from": "2026-09-28", "to": "2026-09-30"},
    "bucket_minutes": null,
    "band_daily": [
      {"date":"2026-09-28 00:00:00","steps":0,"avg_heart_rate":null,"max_heart_rate":0,"avg_spo2":null,"avg_body_temp":null,"records":1120,"last_report_at":"2026-09-28 23:59:53"}
    ],
    "band_segments": [],
    "fitness_history": [
      {"test_date":"2026-04-07 00:00:00","height_cm":110.0,"weight_kg":18.5,"bmi":15.3,"grip_kg":7.2,"long_jump_cm":95,"sit_reach_cm":11,"double_jump_sec":5.2,"obstacle_run_sec":7.0,"balance_beam_sec":3.5,"total_score":75.0,"rating":"合格"}
    ]
  }
}
```

### 3.4 `GET /fitness` — 本班体测记录列表（按批次）

参数：`from` / `to`（可选，体测日期区间）；`limit`（默认 200，最大 500）

```json
{
  "code": 0,
  "data": {
    "class": {"id": 11, "name": "中四班"},
    "from": null, "to": null, "count": 44, "limit": 200,
    "batches": [
      {"date": "2026-05-25 00:00:00", "count": 24},
      {"date": "2026-04-07 00:00:00", "count": 20}
    ],
    "records": [
      {"id": 749, "child_id": 182, "name": "昊*", "gender": "男", "test_date": "2026-05-25 00:00:00",
       "height_cm": 115.5, "weight_kg": 19.1, "bmi": 14.3, "grip_kg": 8.5, "long_jump_cm": 100,
       "sit_reach_cm": 13, "double_jump_sec": 4.9, "obstacle_run_sec": 6.2, "balance_beam_sec": 3.1,
       "total_score": 79.5, "rating": "良好"}
    ]
  }
}
```

评级取值：`优秀` / `良好` / `合格` / `不合格`。历史批次：`2026-04-07`、`2026-05-25`。

### 3.5 `GET /health` — 手环按日聚合健康指标

参数：`date`（可选，默认今天）

```json
{
  "code": 0,
  "data": {
    "class": {"id": 4, "name": "大五班"},
    "date": "2026-09-29",
    "bands": 28,
    "avg": {"heart_rate": 103.2, "spo2": 97.1, "body_temp": 36.6, "total_steps": 930, "max_body_temp": 37.2},
    "hr_zones": [
      {"key": "warmup", "label": "热身 <100", "children": 16},
      {"key": "burn", "label": "燃增 100-139", "children": 6},
      {"key": "aerobic", "label": "有氧强化 140-169", "children": 3},
      {"key": "extreme", "label": "极限 ≥170", "children": 0}
    ],
    "bands_detail": [{"band_mac":"d612d9003419","steps":121,"avg_heart_rate":86.5,"max_heart_rate":130,"avg_spo2":97,"avg_body_temp":36.5,"battery":40,"last_report_at":"2026-09-29 23:59:xx","records":2880}],
    "empty": false, "empty_note": null
  }
}
```

`hr_zones` 按「每个孩子当日平均心率」落在哪个区间计数（区间**人数**，非上报条数）。

---

## 4. 调用示例

```bash
# 大三班当日汇总
curl -H 'X-API-Key: xyjk_<REDACTED-SEE-SERVER>' \
  'https://jiangxiyey.cn/api/class/v1/summary?date=2026-09-29'

# 中一班孩子名单 + 当日手环 + 最新体测
curl -H 'X-API-Key: xyjk_<REDACTED-SEE-SERVER>' \
  'https://jiangxiyey.cn/api/class/v1/children?date=2026-09-30'

# 大三班某幼儿 9/28–9/30 手环 + 体测历史
curl -H 'X-API-Key: xyjk_<REDACTED-SEE-SERVER>' \
  'https://jiangxiyey.cn/api/class/v1/child/290?from=2026-09-28&to=2026-09-30'

# 中四班全部体测批次
curl -H 'X-API-Key: xyjk_<REDACTED-SEE-SERVER>' \
  'https://jiangxiyey.cn/api/class/v1/fitness'

# 大五班某日健康聚合
curl -H 'X-API-Key: xyjk_<REDACTED-SEE-SERVER>' \
  'https://jiangxiyey.cn/api/class/v1/health?date=2026-09-29'
```

## 5. 运维

- 迁移：`mysql -u kindergarten_app --default-character-set=utf8mb4 kindergarten_platform < sql/class-api-20261005.sql`
- 新增班级 Key：
  ```bash
  node -e 'const c=require("crypto");const k="xyjk_"+c.randomBytes(24).toString("hex");console.log(k,c.createHash("sha256").update(k).digest("hex"))'
  # 将哈希入库：INSERT INTO class_api_keys (key_hash,key_prefix,class_id,label,enabled) VALUES (?,?,?,?,1)
  ```
- 审计查询：`SELECT * FROM class_api_logs ORDER BY id DESC LIMIT 50;`