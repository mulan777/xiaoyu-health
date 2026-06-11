# 小鱼健康

小鱼健康是一个面向幼儿园体适能管理的 Web 平台，包含首页、登录、管理员后台、教师端、体测数据、场地预约、报表等功能。

## 技术栈

- Node.js 18
- Express
- EJS
- MySQL 8
- Redis

## 本地运行

```bash
cp .env.example .env
npm ci
npm start
```

默认端口：`3070`。

## 部署文档

详细部署、环境变量、备份说明见 `docs/deployment.md`。

## Docker 运行

```bash
cp .env.example .env
# 修改 .env 里的 SESSION_SECRET、MYSQL_PASSWORD、MYSQL_ROOT_PASSWORD 等配置
docker compose up -d --build
```

访问：`http://localhost:3070`

## 目录说明

- `server.js`：应用入口
- `routes/`：业务路由
- `lib/`：数据库、Excel、AI 报告等工具模块
- `views/`：EJS 页面模板
- `public/`：静态资源
- `biao/`：评分表模板
- `data/templates/`：初始化模板数据

## 注意

- `.env`、日志、上传文件、备份文件、`node_modules` 不进入 Git。
- `public/uploads` 通过 Docker volume 挂载，生产数据需要单独备份。
