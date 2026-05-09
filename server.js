import express from "express";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

dotenv.config();

const PORT = parseInt(process.env.PORT || "3000", 10);
const STUDENTS_DB_PATH = process.env.STUDENTS_DB_PATH || "";
const JWT_SECRET = process.env.JWT_SECRET || randomUUID();
const JWT_EXPIRES_IN = "30d";

const SILICONFLOW_KEY = process.env.SILICONFLOW_KEY || "";
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || "";
const ALIBABA_BAILIAN_KEY = process.env.ALIBABA_BAILIAN_KEY || "";

const APP_ANDROID_VERSION = process.env.APP_ANDROID_VERSION || "1.0.1";
const APP_ANDROID_VERSION_CODE = parseInt(process.env.APP_ANDROID_VERSION_CODE || "2", 10);
const APP_ANDROID_MIN_SUPPORTED_VERSION = process.env.APP_ANDROID_MIN_SUPPORTED_VERSION || "1.0.0";
const APP_ANDROID_DOWNLOAD_URL = process.env.APP_ANDROID_DOWNLOAD_URL || "";
const APP_ANDROID_APK_PATH = process.env.APP_ANDROID_APK_PATH || "ocr-math-latest.apk";
const APP_ANDROID_CHANGELOG = process.env.APP_ANDROID_CHANGELOG || "";
const APP_ANDROID_ANNOUNCEMENT_TITLE = process.env.APP_ANDROID_ANNOUNCEMENT_TITLE || "";
const APP_ANDROID_ANNOUNCEMENT_BODY = process.env.APP_ANDROID_ANNOUNCEMENT_BODY || "";

if (!JWT_SECRET || JWT_SECRET === "change-me-to-a-random-string") {
  console.warn("WARNING: JWT_SECRET is not set or using default value. Generate a random secret.");
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- Databases ----

let studentsDb = null;
if (STUDENTS_DB_PATH) {
  try {
    studentsDb = new Database(STUDENTS_DB_PATH, { readonly: true });
    console.log(`students.db opened (readonly): ${STUDENTS_DB_PATH}`);
  } catch (err) {
    console.error("Failed to open students.db:", err);
  }
} else {
  console.warn("STUDENTS_DB_PATH not set — login will fail");
}

const proxyDb = new Database("proxy.db");
proxyDb.pragma("journal_mode = WAL");
proxyDb.exec(`
  CREATE TABLE IF NOT EXISTS rate_limits (
    student_id TEXT PRIMARY KEY,
    visual_count INTEGER DEFAULT 0,
    reasoning_count INTEGER DEFAULT 0,
    reset_at TEXT NOT NULL
  );
`);

// ---- Helpers ----

function getProviderKey(providerId) {
  switch (providerId) {
    case "siliconflow": return SILICONFLOW_KEY;
    case "deepseek": return DEEPSEEK_KEY;
    case "alibaba_bailian": return ALIBABA_BAILIAN_KEY;
    default: return "";
  }
}

function getProviderBaseUrl(providerId) {
  switch (providerId) {
    case "siliconflow": return "https://api.siliconflow.cn/v1";
    case "deepseek": return "https://api.deepseek.com/v1";
    case "alibaba_bailian": return "https://dashscope.aliyuncs.com/compatible-mode/v1";
    default: return "";
  }
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

function respondError(res, status, message) {
  return res.status(status).json({ error: message });
}

function parseChangelog(raw) {
  return raw
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getAndroidVersionCode() {
  return Number.isFinite(APP_ANDROID_VERSION_CODE) ? APP_ANDROID_VERSION_CODE : 3;
}

// Rate limiting
const VISUAL_LIMIT = 60;
const REASONING_LIMIT = 120;

function checkRateLimit(studentId, requestType) {
  const now = new Date();
  const nowIso = now.toISOString();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const row = proxyDb.prepare("SELECT * FROM rate_limits WHERE student_id = ?").get(studentId);

  const limit = requestType === "visual" ? VISUAL_LIMIT : REASONING_LIMIT;

  if (!row || row.reset_at < hourAgo) {
    proxyDb.prepare(
      `INSERT OR REPLACE INTO rate_limits (student_id, visual_count, reasoning_count, reset_at)
       VALUES (?, ?, ?, ?)`
    ).run(studentId, requestType === "visual" ? 1 : 0, requestType === "reasoning" ? 1 : 0, nowIso);
    return null;
  }

  const count = requestType === "visual" ? row.visual_count : row.reasoning_count;
  if (count >= limit) {
    const resetDate = new Date(row.reset_at);
    const resetMs = resetDate.getTime() + 60 * 60 * 1000 - now.getTime();
    const minutes = Math.ceil(resetMs / 60000);
    return `请求过于频繁（${requestType === "visual" ? "视觉" : "推理"}：${limit}次/小时），请在 ${minutes} 分钟后重试`;
  }

  proxyDb.prepare(
    requestType === "visual"
      ? "UPDATE rate_limits SET visual_count = visual_count + 1 WHERE student_id = ?"
      : "UPDATE rate_limits SET reasoning_count = reasoning_count + 1 WHERE student_id = ?"
  ).run(studentId);

  return null;
}

// ---- Middleware ----

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return respondError(res, 401, "未提供认证令牌");
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.student = payload;
    next();
  } catch {
    return respondError(res, 401, "认证令牌无效或已过期，请重新登录");
  }
}

// ---- Routes ----

app.get("/health", (_req, res) => {
  res.json({ status: "ok", studentsDb: !!studentsDb });
});

app.get("/v1/app/version", (req, res) => {
  const platform = typeof req.query.platform === "string" ? req.query.platform : "android";
  if (platform !== "android") {
    return respondError(res, 400, "暂不支持该平台");
  }

  res.json({
    success: true,
    data: {
      platform: "android",
      latestVersion: APP_ANDROID_VERSION,
      latestVersionCode: getAndroidVersionCode(),
      minSupportedVersion: APP_ANDROID_MIN_SUPPORTED_VERSION,
      downloadUrl: APP_ANDROID_DOWNLOAD_URL,
      apkPath: APP_ANDROID_APK_PATH,
      changelog: parseChangelog(APP_ANDROID_CHANGELOG),
    },
  });
});

app.get("/v1/app/announcement", (req, res) => {
  const platform = typeof req.query.platform === "string" ? req.query.platform : "android";
  if (platform !== "android") {
    return respondError(res, 400, "暂不支持该平台");
  }

  const title = APP_ANDROID_ANNOUNCEMENT_TITLE;
  const body = APP_ANDROID_ANNOUNCEMENT_BODY;

  if (!title && !body) {
    return res.json({
      success: true,
      data: { hasAnnouncement: false },
    });
  }

  res.json({
    success: true,
    data: {
      hasAnnouncement: true,
      title,
      body: body.split("|").map((s) => s.trim()).filter(Boolean),
    },
  });
});

app.post("/v1/auth/login", (req, res) => {
  if (!studentsDb) {
    return respondError(res, 503, "学生数据库未配置");
  }

  const { name, studentId, verificationCode } = req.body;

  if (!name || !studentId || !verificationCode) {
    return respondError(res, 400, "请填写姓名、学号和验证码");
  }

  try {
    const row = studentsDb.prepare(
      "SELECT student_id, name, class FROM student_info WHERE student_id = ? AND name = ? AND verification_code = ?"
    ).get(studentId, name, verificationCode);

    if (!row) {
      return respondError(res, 401, "验证失败，请检查姓名、学号和验证码是否正确");
    }

    const token = jwt.sign(
      { sub: row.student_id, name: row.name, class: row.class },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      token,
      student: {
        studentId: row.student_id,
        name: row.name,
        class: row.class,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    respondError(res, 500, "服务器内部错误");
  }
});

app.post("/v1/chat/completions", authMiddleware, (req, res) => {
  const providerId = req.headers["x-provider"];
  if (!providerId || typeof providerId !== "string") {
    return respondError(res, 400, "缺少 x-provider 请求头");
  }

  const apiKey = getProviderKey(providerId);
  if (!apiKey) {
    return respondError(res, 400, `不支持的供应商: ${providerId}`);
  }

  const baseUrl = getProviderBaseUrl(providerId);
  const studentId = req.student.sub;

  const maxTokens = req.body.max_tokens || 0;
  const requestType = maxTokens >= 30000 ? "reasoning" : "visual";

  const rateLimitMsg = checkRateLimit(studentId, requestType);
  if (rateLimitMsg) {
    return respondError(res, 429, rateLimitMsg);
  }

  const upstreamUrl = `${normalizeUrl(baseUrl)}/chat/completions`;
  const upstreamBody = JSON.stringify(req.body);

  fetch(upstreamUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: upstreamBody,
  })
    .then(async (upstreamRes) => {
      if (!upstreamRes.ok) {
        let errorMsg = `${providerId} 上游错误 (${upstreamRes.status})`;
        try {
          const errBody = await upstreamRes.text();
          const parsed = JSON.parse(errBody);
          errorMsg = parsed?.error?.message || parsed?.message || parsed?.detail || errorMsg;
        } catch {}
        res.status(upstreamRes.status).json({ error: { message: errorMsg }, message: errorMsg });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();

      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) {
            res.end();
            return;
          }
          res.write(decoder.decode(value, { stream: true }));
          pump();
        }).catch(() => {
          res.end();
        });
      }

      pump();
    })
    .catch((err) => {
      console.error("Upstream fetch error:", err);
      if (!res.headersSent) {
        respondError(res, 502, "上游服务连接失败");
      } else {
        res.end();
      }
    });
});

app.listen(PORT, () => {
  console.log(`circuit-proxy listening on port ${PORT}`);
  console.log(`Students DB: ${STUDENTS_DB_PATH || "(not configured)"}`);
  console.log(`SiliconFlow: ${SILICONFLOW_KEY ? "configured" : "NOT CONFIGURED"}`);
  console.log(`DeepSeek: ${DEEPSEEK_KEY ? "configured" : "NOT CONFIGURED"}`);
  console.log(`Alibaba Bailian: ${ALIBABA_BAILIAN_KEY ? "configured" : "NOT CONFIGURED"}`);
});
