#!/bin/bash
# 小鱼健康平台 安全重启 + 自检脚本（固化 2026-09-17 技能纪律）
# 用法: bash /opt/kindergarten-fitness-platform/scripts/restart-with-check.sh
# 作用: 识别真孤儿(父进程非pm2) → 停pm2 → 清残留端口 → pm2启动 → /health 真实验证（MySQL+Redis）
# 铁律: 只动 kindergarten-platform 自己，绝不 pkill 泛匹配（会连带 band-bridge/gate-receiver/tb-yey）
set -u
APP_DIR="/opt/kindergarten-fitness-platform"
APP_NAME="kindergarten-platform"
PORT=3070
ARCHIVE_DIR="$APP_DIR/backups/orphan-archive"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
LOG_TAG="[restart-check]"

echo "$LOG_TAG === 1/5 识别真孤儿（父进程不是 pm2 God Daemon 的 node server.js） ==="
mkdir -p "$ARCHIVE_DIR"
PM2_PIDS=$(pgrep -f "PM2.*God Daemon" | tr '\n' ' ')
TRUE_ORPHANS=""
for PID in $(pgrep -f "node .*${APP_DIR}/server\.js" 2>/dev/null); do
  PPID_VAL=$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d ' ')
  if [ -n "$PPID_VAL" ] && ! echo " $PM2_PIDS " | grep -q " $PPID_VAL "; then
    TRUE_ORPHANS="$TRUE_ORPHANS $PID"
  fi
done
if [ -n "$TRUE_ORPHANS" ]; then
  echo "$LOG_TAG 发现真孤儿:$TRUE_ORPHANS"
  ps -fp $TRUE_ORPHANS >> "$ARCHIVE_DIR/orphans-$(date +%Y%m%d-%H%M%S).log" 2>/dev/null
  kill $TRUE_ORPHANS 2>/dev/null || true
  sleep 1
else
  echo "$LOG_TAG 无真孤儿（pm2 子进程不算）"
fi

echo "$LOG_TAG === 2/5 停 pm2 + 清残留端口 ==="
pm2 stop "$APP_NAME" 2>/dev/null || true
for i in $(seq 1 10); do
  if ! ss -ltnp | grep -q ":${PORT} "; then break; fi
  # 只杀占 3070 端口的具体进程，不泛匹配
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 1
done
if ss -ltnp | grep -q ":${PORT} "; then
  echo "$LOG_TAG ❌ 端口 $PORT 仍被占，中止（请人工检查）"
  exit 1
fi
echo "$LOG_TAG 端口 $PORT 已释放"

echo "$LOG_TAG === 3/5 pm2 启动 ==="
pm2 start "$APP_NAME" 2>/dev/null || pm2 start "$APP_DIR/ecosystem.config.js"
pm2 save 2>/dev/null || true

echo "$LOG_TAG === 4/5 等待就绪（最多 30s） ==="
READY=0
BODY=""
for i in $(seq 1 30); do
  BODY=$(curl -sf --max-time 2 "$HEALTH_URL" 2>/dev/null) && READY=1 && break
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "$LOG_TAG ❌ 30s 内 /health 未就绪，最近错误日志："
  pm2 logs "$APP_NAME" --err --lines 20 --nostream
  exit 2
fi

echo "$LOG_TAG === 5/5 健康自检（MySQL + Redis 全链路） ==="
echo "$BODY"
OK=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('PASS' if d.get('ok') and d.get('mysql') and d.get('redis') else 'FAIL')" 2>/dev/null)
if [ "$OK" != "PASS" ]; then
  echo "$LOG_TAG ❌ /health 返回异常（mysql/redis 缺失）"
  exit 3
fi

echo "$LOG_TAG === band-jobs tick 验证 ==="
sleep 2
if pm2 logs "$APP_NAME" --lines 50 --nostream 2>/dev/null | grep -q "手环定时任务已启动"; then
  echo "$LOG_TAG ✅ band-jobs tick 在跑（定时任务已启动）"
else
  echo "$LOG_TAG ⚠️  未见「手环定时任务已启动」，band-jobs 可能未跑，须人工检查"
fi

echo "$LOG_TAG ✅ 重启完成，全链路通过"
