# 小鱼健康部署文档

本文档说明如何从 GitHub 拉取“小鱼健康”项目，并使用 Docker / Docker Compose 启动服务。

## 1. 项目地址

- GitHub: https://github.com/mulan777/xiaoyu-health
- 默认端口: 3070
- 应用入口: `server.js`
- 技术栈: Node.js 18 + Express + EJS + MySQL + Redis

## 2. 仓库内容说明

仓库只保留运行项目需要的源码和静态资源，下列内容不会上传到 GitHub:

- `.env` 和其他本地环境变量文件
- `node_modules/`
- `logs/` 和 `*.log`
- `public/uploads/` 上传文件
- `backups/`、`.deploy-backups/` 备份目录
- `*.bak`、`*.tmp`、`*.upload.tmp` 等临时或备份文件

如果需要迁移生产数据，请单独备份数据库和 `public/uploads/`，不要依赖 Git 仓库保存生产数据。

## 3. 环境变量

首次部署时复制示例配置:

```bash
cp .env.example .env
```

至少需要检查并修改以下变量:

```bash
PORT=3070
SESSION_SECRET=change-me
MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_DATABASE=kindergarten_platform
MYSQL_USER=kindergarten_app
MYSQL_PASSWORD=change-me
MYSQL_ROOT_PASSWORD=change-me
REDIS_URL=redis://redis:6379
```

说明:

- `SESSION_SECRET` 必须改成随机长字符串。
- `MYSQL_PASSWORD` 和 `MYSQL_ROOT_PASSWORD` 必须改成强密码。
- 使用 `docker-compose.yml` 时，应用容器内的 `MYSQL_HOST` 应为 `mysql`，`REDIS_URL` 应为 `redis://redis:6379`。
- 如果连接已有外部 MySQL / Redis，请改成实际地址。

## 4. Docker Compose 部署

```bash
git clone https://github.com/mulan777/xiaoyu-health.git
cd xiaoyu-health
cp .env.example .env
# 编辑 .env 后启动
docker compose up -d --build
```

查看状态:

```bash
docker compose ps
docker compose logs -f app
```

访问服务:

```bash
curl http://127.0.0.1:3070/
```

浏览器访问 `http://服务器IP:3070/`。

## 5. 单独构建镜像

如果只需要构建镜像:

```bash
docker build -t xiaoyu-health:latest .
```

使用已有 MySQL / Redis 运行示例:

```bash
docker run -d --name xiaoyu-health \
  --restart unless-stopped \
  --env-file .env \
  -p 3070:3070 \
  -v ./public/uploads:/app/public/uploads \
  -v ./logs:/app/logs \
  xiaoyu-health:latest
```

## 6. 数据备份建议

生产环境建议定期备份:

```bash
# MySQL 数据库
mysqldump -h <mysql_host> -u <mysql_user> -p kindergarten_platform > xiaoyu-health.sql

# 上传文件
 tar -czf xiaoyu-uploads.tar.gz public/uploads
```

恢复时先恢复 MySQL 数据，再恢复 `public/uploads/`。

## 7. 常见问题

### 7.1 容器启动后访问失败

先查看日志:

```bash
docker compose logs --tail=100 app
```

重点检查:

- MySQL 地址、用户名、密码是否正确
- Redis 地址是否正确
- 3070 端口是否被占用
