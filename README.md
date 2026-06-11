# 小鱼健康

小鱼健康是一个面向幼儿园体适能管理的 Web 平台，包含首页、登录、管理员后台、教师端、体测数据管理、场地预约、报表导入导出、AI 智能体测分析报告等功能。

## 项目地址

- GitHub 源码：<https://github.com/mulan777/xiaoyu-health>
- 默认端口：`3070`
- 应用入口：`server.js`

## 功能概览

- 首页展示、登录页、管理员后台、教师端工作台
- 用户、角色、权限、班级、幼儿档案管理
- 体测数据录入、批量导入、导出、评分分析
- 场地预约、场地配置、预约统计
- AI 智能体测分析报告
- 手机 / 电脑自适应 UI

## 技术栈

- Node.js 18
- Express
- EJS
- MySQL 8
- Redis
- Docker / Docker Compose

## 一、最快 Docker 部署方式

服务器安装好 Docker 和 Docker Compose 后，直接从 GitHub 拉源码构建：

```bash
git clone https://github.com/mulan777/xiaoyu-health.git
cd xiaoyu-health
# 可先编辑 docker-compose.yml 里的 SESSION_SECRET / MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD
docker compose up -d --build
```

启动后访问：

```text
http://服务器IP:3070/
```

查看状态：

```bash
docker compose ps
docker compose logs -f app
```

停止服务：

```bash
docker compose down
```

更新源码并重建：

```bash
cd xiaoyu-health
git pull
docker compose up -d --build
```

## 二、推荐生产部署方式：直接改 docker-compose.yml

本项目可以直接在 `docker-compose.yml` 里配置 MySQL、Redis 和应用参数。重点改下面这些值：

```yaml
environment:
  PORT: 3070
  SESSION_SECRET: please-change-this-session-secret
  MYSQL_DATABASE: kindergarten_platform
  MYSQL_USER: kindergarten_app
  MYSQL_PASSWORD: please-change-this-mysql-password
```

MySQL 容器里也要同步改：

```yaml
environment:
  MYSQL_DATABASE: kindergarten_platform
  MYSQL_USER: kindergarten_app
  MYSQL_PASSWORD: please-change-this-mysql-password
  MYSQL_ROOT_PASSWORD: please-change-this-root-password
```

说明：

- `SESSION_SECRET`：登录 Session 加密密钥，必须改成随机长字符串。
- `MYSQL_PASSWORD`：应用连接 MySQL 的密码，两处必须保持一致。
- `MYSQL_ROOT_PASSWORD`：MySQL root 密码，只给数据库管理员使用。
- `MYSQL_DATABASE`：默认数据库名，建议保持 `kindergarten_platform`。
- `MYSQL_USER`：应用数据库用户，建议保持 `kindergarten_app`。

修改完成后启动：

```bash
docker compose up -d
```

## 三、MySQL 配置说明

小鱼健康使用 MySQL 保存业务数据，例如用户、班级、幼儿档案、体测记录、场地预约、AI 配置等。

### 1. 使用 Docker Compose 自带 MySQL

默认 `docker-compose.yml` 会自动启动一个 MySQL 8 容器：

- 容器名：`xiaoyu-health-mysql`
- 数据卷：`mysql_data`
- 数据库：`kindergarten_platform`
- 应用用户：`kindergarten_app`
- 容器内端口：`3306`
- 宿主机只监听本机：`127.0.0.1:3306`

应用容器连接 MySQL 时使用：

```yaml
MYSQL_HOST: mysql
MYSQL_PORT: 3306
MYSQL_DATABASE: kindergarten_platform
MYSQL_USER: kindergarten_app
MYSQL_PASSWORD: 数据库密码
```

为什么 `MYSQL_HOST` 是 `mysql`：因为在 Docker Compose 内部，服务名 `mysql` 就是 MySQL 容器的网络地址，不要写 `127.0.0.1`。

### 2. 使用已有外部 MySQL

如果你已经有 MySQL，不想用 Compose 自带 MySQL，可以这样改：

```yaml
services:
  app:
    environment:
      MYSQL_HOST: MySQL地址
      MYSQL_PORT: 3306
      MYSQL_DATABASE: kindergarten_platform
      MYSQL_USER: kindergarten_app
      MYSQL_PASSWORD: 数据库密码
```

然后删除或注释掉 `mysql:` 这个服务，以及 `depends_on` 里的 `mysql`。

需要提前创建数据库和用户，例如：

```sql
CREATE DATABASE kindergarten_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'kindergarten_app'@'%' IDENTIFIED BY '数据库密码';
GRANT ALL PRIVILEGES ON kindergarten_platform.* TO 'kindergarten_app'@'%';
FLUSH PRIVILEGES;
```

### 3. 数据库初始化

应用启动时会自动检查并初始化需要的数据表，所以通常不需要手动导入 SQL。

如果日志里看到 MySQL 连接失败，重点检查：

- `MYSQL_HOST` 是否写对
- `MYSQL_USER` / `MYSQL_PASSWORD` 是否一致
- MySQL 容器是否启动完成
- 3306 端口是否被防火墙或安全组拦截

查看 MySQL 日志：

```bash
docker compose logs --tail=100 mysql
```

进入 MySQL：

```bash
docker exec -it xiaoyu-health-mysql mysql -uroot -p
```

## 四、Redis 配置说明

Redis 用于保存登录 Session，提高登录状态稳定性。

Docker Compose 默认启动 Redis：

- 容器名：`xiaoyu-health-redis`
- 服务名：`redis`
- 容器内端口：`6379`

应用容器内配置：

```yaml
REDIS_URL: redis://redis:6379
```

如果使用外部 Redis，把 `REDIS_URL` 改成实际地址即可：

```yaml
REDIS_URL: redis://Redis地址:6379
```

## 五、AI 智能分析配置

小鱼健康的 AI 功能用于生成体测智能分析报告。AI 配置不是写死在代码里的，而是在后台页面配置，保存在 MySQL 里。

进入后台：

```text
http://服务器IP:3070/admin
```

找到：

```text
管理后台 -> AI 接入
```

需要配置这些项目：

| 配置项 | 说明 | 示例 |
| --- | --- | --- |
| 启用 AI 智能分析 | 开启后才能生成 AI 报告 | 勾选 |
| 供应商名称 | 方便后台显示 | DeepSeek / 通义 / 智谱 / Kimi |
| 接口 Base URL | OpenAI 兼容接口地址，填到 `/v1` 即可 | `https://api.deepseek.com/v1` |
| API Key | 模型供应商的密钥 | `sk-...` |
| 模型名称 | 实际调用的模型 ID | `deepseek-chat` / `qwen-plus` |
| 最大输出 Token | 输出长度上限，0 表示交给模型默认 | `1800` 或 `0` |
| 温度 Temperature | 创造性参数 | `0.6` |
| 超时 | 请求超时时间，单位毫秒 | `600000` |
| 系统提示词 | 传给模型的 system prompt | 儿童体适能专家提示词 |

### 常见 AI 供应商配置示例

DeepSeek：

```text
Base URL: https://api.deepseek.com/v1
Model: deepseek-chat
```

通义千问：

```text
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model: qwen-plus
```

智谱 GLM：

```text
Base URL: https://open.bigmodel.cn/api/paas/v4
Model: glm-4-air
```

Moonshot Kimi：

```text
Base URL: https://api.moonshot.cn/v1
Model: moonshot-v1-8k
```

配置完成后点击后台的“测试连通性”。如果测试通过，就可以到“体测数据管理”页面点击“AI 智能分析报告”。

注意：

- API Key 只保存在服务端数据库中，页面不会明文回显，只显示掩码。
- 如果更换供应商，只需要改 Base URL、API Key、模型名称。
- 只要供应商兼容 OpenAI Chat Completions 协议，一般都能接入。

## 六、从源码构建 Docker 镜像

如果需要手动构建镜像，可以执行：

```bash
git clone https://github.com/mulan777/xiaoyu-health.git
cd xiaoyu-health
docker build -t xiaoyu-health:latest .
```

本地运行示例：

```bash
docker run -d --name xiaoyu-health \
  --restart unless-stopped \
  -e PORT=3070 \
  -e SESSION_SECRET=please-change-this-session-secret \
  -e MYSQL_HOST=MySQL地址 \
  -e MYSQL_PORT=3306 \
  -e MYSQL_DATABASE=kindergarten_platform \
  -e MYSQL_USER=kindergarten_app \
  -e MYSQL_PASSWORD=数据库密码 \
  -e REDIS_URL=redis://Redis地址:6379 \
  -p 3070:3070 \
  -v ./public/uploads:/app/public/uploads \
  -v ./logs:/app/logs \
  xiaoyu-health:latest
```

## 七、数据备份和恢复

### 1. 备份 MySQL

```bash
docker exec xiaoyu-health-mysql mysqldump -uroot -p kindergarten_platform > xiaoyu-health.sql
```

### 2. 备份上传文件

```bash
tar -czf xiaoyu-uploads.tar.gz public/uploads
```

### 3. 恢复 MySQL

```bash
docker exec -i xiaoyu-health-mysql mysql -uroot -p kindergarten_platform < xiaoyu-health.sql
```

### 4. 恢复上传文件

```bash
tar -xzf xiaoyu-uploads.tar.gz -C ./
```

## 八、常见问题排查

### 1. 页面打不开

检查容器是否运行：

```bash
docker compose ps
```

检查应用日志：

```bash
docker compose logs --tail=100 app
```

检查端口：

```bash
ss -ltnp | grep 3070
```

### 2. MySQL 连接失败

应用日志里如果出现 `Access denied`、`ECONNREFUSED`、`ETIMEDOUT`，说明数据库连接配置有问题。

常见原因：

- `MYSQL_PASSWORD` 两处不一致
- `MYSQL_HOST` 写成了 `127.0.0.1`，但在 Compose 里应该写 `mysql`
- MySQL 首次初始化还没完成，等 30 秒后再看
- 使用外部 MySQL 时，防火墙没放通 3306

### 3. AI 报告不能生成

检查后台 AI 接入配置：

- 是否勾选“启用 AI 智能分析”
- API Key 是否填写
- Base URL 是否填到 `/v1`
- 模型名是否正确
- “测试连通性”是否成功
