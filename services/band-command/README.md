# band-command — YT9 手环下行命令服务

独立 pm2 服务（默认端口 3079），平台通过 `/admin/bands/command/api/*` 代理访问。

## 功能
- 手动震动（可调秒数，服务端实现：找手环开→计时→关）
- 心率检测频次下发（15/30/60 分钟档）
- 心率阈值监听（实时心率 ≥ 阈值自动下发震动，带冷却）
- 下发记录落库 `band_commands`，全局设置 `band_command_settings`

## 部署
```bash
ln -sf /opt/band-bridge/node_modules node_modules   # 复用 mqtt/mysql2
pm2 start ecosystem.config.js && pm2 save
```

## 平台侧
- `routes/bands.js` 提供 `/admin/bands/command` 页面与 API 代理（鉴权走平台）
- `views/admin-band-command.ejs` 管理界面

## 关键协议要点（排障必读）
1. 网关 response 不回显请求 msgId（网关自维护递增），按 resp 类型 + mac 匹配
2. 回执在 GwData `pkt_type=state`/`sta_device_data` 的 `data.recv_infos.raw`；conn_send_data 的 result 也在 GwData（pkt_type=response）
3. sendFrames 的 Promise resolve 必须存进 pendingSend entry（漏存 → TypeError 被吞 → 永远超时）
4. 关键路径上 await DB 更新会让 sendFrames 注册晚于网关 response，status 更新要 fire-and-forget
5. 网关 keep_time 须 > 震动秒数+5，否则自动关闭帧发不出
