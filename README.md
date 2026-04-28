# CircuitCalculus Helper Proxy

[CircuitCalculus Helper](https://github.com/Roast-2007/CircuitCalculus-Helper) 的 API 代理服务器，用于保护 AI 供应商 API Key 并对用户进行鉴权与速率限制。

## 工作原理

```
App (设备) ──Bearer<JWT>──> Proxy Server ──Bearer<真实Key>──> AI 供应商
              POST /v1/chat/completions                     SiliconFlow / DeepSeek / Bailian
              x-provider: deepseek
```

1. 用户在 App 内使用姓名、学号、验证码登录
2. 服务器查询 SQLite 学生数据库验证身份，返回 JWT（30 天有效）
3. 后续 API 请求携带 JWT，服务器代发请求到 AI 供应商
4. 真实 API Key 仅存放在服务器 `.env` 中，设备永远无法获取

## 技术栈

- Node.js + Express 5
- better-sqlite3（SQLite 数据库）
- jsonwebtoken（JWT 鉴权）
- SSE 流式代理（支持视觉识别与推理模型）

## 快速部署

### 1. 上传到服务器

```bash
# 将整个目录上传到服务器
scp -r circuit-proxy/ user@your-server:/www/wwwroot/circuit-proxy/
```

### 2. 安装依赖

```bash
cd /www/wwwroot/circuit-proxy
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
PORT=3000
STUDENTS_DB_PATH=students.db
JWT_SECRET=生成一个随机长字符串
SILICONFLOW_KEY=sk-xxx
DEEPSEEK_KEY=sk-xxx
ALIBABA_BAILIAN_KEY=sk-xxx
```

### 4. 启动服务

```bash
# 直接启动
node server.js

# 或使用 PM2（推荐）
pm2 start server.js --name circuit-proxy
pm2 save
```

### 5. 配置反向代理（可选）

在 Nginx / 宝塔面板中添加反向代理，将域名请求转发到 `http://127.0.0.1:3000`。

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/auth/login` | POST | 学生登录，返回 JWT |
| `/v1/chat/completions` | POST | 代理 API 请求（需 JWT + `x-provider` header） |
| `/health` | GET | 健康检查 |

### 登录

```bash
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"name":"张三","studentId":"42506453","verificationCode":"1234"}'
```

### 代理请求

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <JWT>" \
  -H "x-provider: deepseek" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 速率限制

- 视觉识别：60 次/小时/学生
- 推理模型：120 次/小时/学生

超限后返回 429 状态码，提示剩余等待时间。

## 学生数据库

本服务复用 [CircuitCalculus Helper](https://github.com/Roast-2007/CircuitCalculus-Helper) 配套成绩查询网站的学生数据库（SQLite），以只读方式打开，不会修改原数据。

`student_info` 表结构：

| 列 | 类型 | 说明 |
|----|------|------|
| `student_id` | TEXT PK | 学号 |
| `name` | TEXT | 姓名 |
| `class` | TEXT | 班级 |
| `verification_code` | TEXT | 验证码（身份证后四位） |

## 远程仓库

```text
https://github.com/Roast-2007/CircuitCalculus-Helper-Proxy
```

## License

本项目基于 [MIT License](LICENSE) 开源。
