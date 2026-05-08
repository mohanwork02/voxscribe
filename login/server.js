const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const fsp = require("fs/promises");
const nodemailer = require("nodemailer");
const path = require("path");
require("dotenv").config();

const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD_ROUNDS = 12;
const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_INACTIVE_TTL_MS = 2 * 60 * 1000;
const USER_SESSION_COOKIE_NAME = "voxscribe_user_session";
const SUPERUSER_SESSION_COOKIE_NAME = "voxscribe_superuser_session";
const DEVICE_ID_COOKIE_NAME = "voxscribe_device_id";
const DEVICE_ID_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const TAB_TOKEN_HEADER_NAME = "x-voxscribe-tab";
const FRONTEND_DIST_PATH = path.join(__dirname, "frontend", "dist");
const FRONTEND_INDEX_PATH = path.join(FRONTEND_DIST_PATH, "index.html");
const SMART_INPUT_UPLOAD_ROOT = path.join(__dirname, "uploads");
const TRANSCRIPT_BACKEND_BASE_URL = String(
  process.env.TRANSCRIPT_BACKEND_URL || process.env.PYTHON_BACKEND_URL || "http://127.0.0.1:8000"
).replace(/\/+$/, "");
const otpChallenges = new Map();
const userSessions = new Map();
const superUserSessions = new Map();

function buildTranscriptWebSocketTargetUrl(requestUrl) {
  const targetUrl = new URL("/api/transcript/ws", `${TRANSCRIPT_BACKEND_BASE_URL}/`);
  targetUrl.search = requestUrl.search;
  return targetUrl;
}

function writeUpgradeResponse(socket, statusCode, statusMessage, headers = {}) {
  const headerLines = [];

  for (const [key, value] of Object.entries(headers)) {
    if (value == null) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => {
        headerLines.push(`${key}: ${item}`);
      });
      continue;
    }

    headerLines.push(`${key}: ${value}`);
  }

  socket.write(`HTTP/1.1 ${statusCode} ${statusMessage}\r\n${headerLines.join("\r\n")}\r\n\r\n`);
}

function rejectUpgrade(socket, statusCode, statusMessage) {
  writeUpgradeResponse(socket, statusCode, statusMessage, {
    Connection: "close",
    "Content-Length": "0",
  });
  socket.end();
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(FRONTEND_DIST_PATH));

function sanitizeUploadFilename(value) {
  const raw = String(value || "").trim();
  const normalized = raw.replace(/[\\/]+/g, "_").replace(/[\0\r\n\t]/g, "_").slice(-160);
  return normalized || "document";
}

function isAllowedSmartInputUpload(filename) {
  const ext = path.extname(String(filename || "").trim()).toLowerCase();
  return ext === ".pdf" || ext === ".docx" || ext === ".txt" || ext === ".md";
}

function tenantUploadBaseDir(tenantId, userId) {
  const t = String(tenantId || "").trim();
  const u = String(userId || "").trim();
  if (!t || !u) {
    return "";
  }
  return path.resolve(path.join(SMART_INPUT_UPLOAD_ROOT, t, u));
}

function filterTenantUploadPaths(files, tenantId, userId) {
  if (!Array.isArray(files)) {
    return [];
  }

  const baseDir = tenantUploadBaseDir(tenantId, userId);
  if (!baseDir) {
    return [];
  }

  const out = [];
  for (const item of files) {
    const raw = String(item || "").trim();
    if (!raw) {
      continue;
    }
    const resolved = path.resolve(raw);
    if (resolved === baseDir || resolved.startsWith(`${baseDir}${path.sep}`)) {
      out.push(resolved);
    }
  }
  return out;
}

process.on("exit", (code) => {
  console.log(`Process exit code: ${code}`);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

app.get("/", (req, res) => {
  res.sendFile(FRONTEND_INDEX_PATH);
});

app.get("/superadmin-login", (req, res) => {
  res.sendFile(FRONTEND_INDEX_PATH);
});

app.get("/app", async (req, res) => {
  const session = await getUserSessionFromRequestLoose(req);

  if (!session) {
    return res.redirect("/");
  }

  res.sendFile(FRONTEND_INDEX_PATH);
});

app.get("/admin", (req, res) => {
  const session = getSuperUserSessionFromRequestLoose(req);

  if (!session) {
    return res.redirect("/superadmin-login");
  }

  res.sendFile(FRONTEND_INDEX_PATH);
});

app.get("/api/health/db", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT current_database() AS database_name, current_user AS database_user, NOW() AS server_time"
    );

    return res.status(200).json({
      success: true,
      database: result.rows[0],
      message: "Database connection is working.",
    });
  } catch (error) {
    console.error("Database health check error:", error);
    return res.status(500).json({
      success: false,
      message: "Database connection failed.",
    });
  }
});

app.post(
  "/api/smart-input/upload",
  requireUser,
  express.raw({ type: "application/octet-stream", limit: "25mb" }),
  async (req, res) => {
    try {
      const filename = sanitizeUploadFilename(req.query.filename || req.headers["x-file-name"] || "");

      if (!isAllowedSmartInputUpload(filename)) {
        return res.status(400).json({
          success: false,
          message: "Only PDF, DOCX, TXT, and MD files are supported for Smart Input.",
        });
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Upload body is empty.",
        });
      }

      const userId = String(req.user?.userId || "unknown").trim() || "unknown";
      const tenantId = String(req.user?.tenantId || "").trim() || `tenant_${userId}`;
      const userDir = path.join(SMART_INPUT_UPLOAD_ROOT, tenantId, userId);
      await fsp.mkdir(userDir, { recursive: true });

      const ext = path.extname(filename).toLowerCase();
      const safeBase = path.basename(filename, ext).replace(/[^a-z0-9._-]/gi, "_").slice(0, 60) || "document";
      const storedName = `${safeBase}_${Date.now()}_${crypto.randomUUID()}${ext}`;
      const storedPath = path.join(userDir, storedName);

      await fsp.writeFile(storedPath, req.body);

      return res.status(200).json({
        success: true,
        filename,
        filePath: storedPath,
        size: req.body.length,
      });
    } catch (error) {
      console.error("Smart input upload error:", error);
      return res.status(500).json({
        success: false,
        message: "Unable to upload Smart Input document.",
      });
    }
  }
);

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizePassword(password) {
  return String(password || "").trim();
}

function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

function parseValidDays(value, fallback = 30) {
  const days = Number.parseInt(String(value || "").trim(), 10);

  if (!Number.isInteger(days) || days < 1 || days > 30) {
    return fallback;
  }

  return days;
}

function parseAllowedDevices(value, fallback = 1) {
  const devices = Number.parseInt(String(value || "").trim(), 10);

  if (!Number.isInteger(devices) || devices < 1 || devices > 5) {
    return fallback;
  }

  return devices;
}

function getConfiguredSuperAdmin() {
  const email = normalizeEmail(process.env.SUPERADMIN_EMAIL);
  const password = String(process.env.SUPERADMIN_PASSWORD || "");
  const passwordHash = String(process.env.SUPERADMIN_PASSWORD_HASH || "");

  if (!email) {
    return null;
  }

  if (!password && !passwordHash) {
    return null;
  }

  return {
    email,
    password,
    passwordHash,
  };
}

function parseActiveValue(value, fallback = true) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return fallback;
}

function generateOtp() {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

function clearExpiredOtpChallenges() {
  const now = Date.now();

  for (const [challengeId, challenge] of otpChallenges.entries()) {
    if (challenge.expiresAt <= now) {
      otpChallenges.delete(challengeId);
    }
  }
}

function clearExpiredSessions(sessionStore) {
  const now = Date.now();

  for (const [sessionId, session] of sessionStore.entries()) {
    if (session.expiresAt <= now) {
      sessionStore.delete(sessionId);
    }
  }
}

function parseCookies(headerValue) {
  return String(headerValue || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");

      if (separatorIndex === -1) {
        return cookies;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function appendSetCookieHeader(res, cookieValue) {
  if (!cookieValue) {
    return;
  }

  const previous = res.getHeader("Set-Cookie");

  if (!previous) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  if (Array.isArray(previous)) {
    res.setHeader("Set-Cookie", [...previous, cookieValue]);
    return;
  }

  res.setHeader("Set-Cookie", [previous, cookieValue]);
}

function buildDeviceIdCookie(deviceId) {
  const parts = [
    `${DEVICE_ID_COOKIE_NAME}=${encodeURIComponent(deviceId)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${DEVICE_ID_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];

  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function getOrCreateDeviceId(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const existing = String(cookies[DEVICE_ID_COOKIE_NAME] || "").trim();

  if (existing) {
    return existing;
  }

  const deviceId = crypto.randomUUID();
  appendSetCookieHeader(res, buildDeviceIdCookie(deviceId));
  return deviceId;
}

function normalizeTabToken(token) {
  return String(token || "").trim();
}

function getTabTokenFromRequest(req) {
  return normalizeTabToken(req?.headers?.[TAB_TOKEN_HEADER_NAME] || req?.query?.tabToken || "");
}

function requireTabTokenMatch(tabToken, storedToken) {
  const normalizedToken = normalizeTabToken(tabToken);
  const normalizedStored = normalizeTabToken(storedToken);
  return Boolean(normalizedToken && normalizedStored && normalizedToken === normalizedStored);
}

function getSessionFromRequest(req, cookieName, sessionStore) {
  clearExpiredSessions(sessionStore);

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[cookieName];

  if (!sessionId) {
    return null;
  }

  const session = sessionStore.get(sessionId);

  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessionStore.delete(sessionId);
    return null;
  }

  return session;
}

async function getUserSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[USER_SESSION_COOKIE_NAME];
  const tabToken = getTabTokenFromRequest(req);

  if (!sessionId) {
    return null;
  }

  const result = await pool.query(
    `SELECT s.session_id, s.user_id, s.expires_at, u.email, s.tab_token, u.tenant_id
     FROM app_user_session s
     JOIN app_user u ON u.id = s.user_id
     WHERE s.session_id = $1
        AND s.expires_at > NOW()
     LIMIT 1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  if (!requireTabTokenMatch(tabToken, row.tab_token)) {
    return null;
  }

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    tenantId: String(row.tenant_id || "").trim(),
    email: row.email,
    expiresAt: new Date(row.expires_at).getTime(),
  };
}

async function getUserSessionFromRequestLoose(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[USER_SESSION_COOKIE_NAME];

  if (!sessionId) {
    return null;
  }

  const result = await pool.query(
    `SELECT s.session_id, s.user_id, s.expires_at, u.email, u.tenant_id
     FROM app_user_session s
     JOIN app_user u ON u.id = s.user_id
     WHERE s.session_id = $1
       AND s.expires_at > NOW()
     LIMIT 1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    tenantId: String(row.tenant_id || "").trim(),
    email: row.email,
    expiresAt: new Date(row.expires_at).getTime(),
  };
}

async function clearExpiredUserSessions(client = pool) {
  await client.query(`DELETE FROM app_user_session WHERE expires_at <= NOW()`);
}

async function deleteUserSessionById(sessionId) {
  await pool.query(`DELETE FROM app_user_session WHERE session_id = $1`, [sessionId]);
}

async function deleteUserSessionsForDevice(userId, deviceId) {
  const normalizedDeviceId = String(deviceId || "").trim();

  if (!normalizedDeviceId) {
    return;
  }

  await pool.query(`DELETE FROM app_user_session WHERE user_id = $1 AND device_id = $2`, [
    Number(userId),
    normalizedDeviceId,
  ]);
}

async function createUserSessionWithLimit(user, maxSessions, deviceId, tabToken) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [Number(user.id)]);
    await clearExpiredUserSessions(client);

    const allowed = Math.max(1, Number(maxSessions || 1));
    const normalizedDeviceId = String(deviceId || "").trim();
    const normalizedTabToken = normalizeTabToken(tabToken);

    if (!normalizedDeviceId || !normalizedTabToken) {
      await client.query("ROLLBACK");
      return { limitExceeded: true, session: null };
    }

    await client.query(
      `DELETE FROM app_user_session
       WHERE user_id = $1
         AND expires_at > NOW()
         AND device_id = session_id
         AND tab_token = session_id`,
      [user.id]
    );

    await client.query(
      `DELETE FROM app_user_session
       WHERE user_id = $1
         AND expires_at > NOW()
         AND last_seen_at < NOW() - ($2 * INTERVAL '1 millisecond')`,
      [user.id, SESSION_INACTIVE_TTL_MS]
    );

    const activeSessionsResult = await client.query(
      `SELECT session_id, COALESCE(NULLIF(device_id, ''), session_id) AS device_id
       FROM app_user_session
       WHERE user_id = $1
         AND expires_at > NOW()`,
      [user.id]
    );

    const activeDeviceIds = new Set(
      activeSessionsResult.rows
        .map((row) => String(row.device_id || "").trim())
        .filter(Boolean)
    );

    const deviceAlreadyActive = activeDeviceIds.has(normalizedDeviceId);

    if (activeDeviceIds.size >= allowed && !deviceAlreadyActive) {
      await client.query("ROLLBACK");
      return { limitExceeded: true, session: null };
    }

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await client.query(
      `INSERT INTO app_user_session (session_id, user_id, expires_at, device_id, tab_token)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, user.id, expiresAt, normalizedDeviceId, normalizedTabToken]
    );

    await client.query(
      `UPDATE app_user
       SET login_count = COALESCE(login_count, 0) + 1
       WHERE id = $1`,
      [user.id]
    );

    await client.query("COMMIT");

    return {
      limitExceeded: false,
      session: {
        sessionId,
        userId: user.id,
        email: user.email,
        expiresAt: expiresAt.getTime(),
      },
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function createSession(sessionStore, user, tabToken = "") {
  clearExpiredSessions(sessionStore);

  const sessionId = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const session = {
    sessionId,
    userId: user.id,
    email: user.email,
    expiresAt,
    tabToken: normalizeTabToken(tabToken),
  };

  sessionStore.set(sessionId, session);
  return session;
}

function getSuperUserSessionFromRequest(req) {
  const session = getSessionFromRequest(req, SUPERUSER_SESSION_COOKIE_NAME, superUserSessions);

  if (!session) {
    return null;
  }

  const tabToken = getTabTokenFromRequest(req);

  if (!requireTabTokenMatch(tabToken, session.tabToken)) {
    return null;
  }

  return session;
}

function getSuperUserSessionFromRequestLoose(req) {
  return getSessionFromRequest(req, SUPERUSER_SESSION_COOKIE_NAME, superUserSessions);
}

function buildSessionCookie(cookieName, sessionId) {
  const parts = [
    `${cookieName}=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
  ];

  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function clearSessionCookie(cookieName) {
  return `${cookieName}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

function requireUser(req, res, next) {
  Promise.resolve()
    .then(async () => {
      const session = await getUserSessionFromRequest(req);

      if (!session) {
        res.status(401).json({
          success: false,
          message: "User login required.",
        });
        return;
      }

      req.user = session;
      next();
    })
    .catch((error) => next(error));
}

function requireSuperUser(req, res, next) {
  const session = getSuperUserSessionFromRequest(req);

  if (!session) {
    return res.status(403).json({
      success: false,
      message: "SuperUser login is required",
    });
  }

  req.superUser = session;
  next();
}

async function ensureDatabaseSetup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_user (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT '',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      allow_devices INTEGER NOT NULL DEFAULT 1,
      valid_days INTEGER NOT NULL DEFAULT 30,
      login_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    ALTER TABLE app_user
    ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE app_user
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE app_user
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  await pool.query(`
    ALTER TABLE app_user
    ADD COLUMN IF NOT EXISTS allow_devices INTEGER NOT NULL DEFAULT 1
  `);

  await pool.query(`
    ALTER TABLE app_user
    ADD COLUMN IF NOT EXISTS valid_days INTEGER NOT NULL DEFAULT 30
  `);

  await pool.query(`
    ALTER TABLE app_user
    ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE app_user
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  `);

  await pool.query(`
    UPDATE app_user
    SET tenant_id = CONCAT('tenant_', id)
    WHERE tenant_id IS NULL OR tenant_id = ''
  `);

  await pool.query(`
    UPDATE app_user
    SET expires_at = created_at + (valid_days || ' days')::INTERVAL
    WHERE expires_at IS NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_user_session (
      session_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      device_id TEXT NOT NULL DEFAULT '',
      tab_token TEXT NOT NULL DEFAULT '',
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    ALTER TABLE app_user_session
    ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE app_user_session
    ADD COLUMN IF NOT EXISTS tab_token TEXT NOT NULL DEFAULT ''
  `);

  await pool.query(`
    ALTER TABLE app_user_session
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  await pool.query(`
    UPDATE app_user_session
    SET device_id = session_id
    WHERE device_id IS NULL OR device_id = ''
  `);

  await pool.query(`
    UPDATE app_user_session
    SET tab_token = session_id
    WHERE tab_token IS NULL OR tab_token = ''
  `);

  await pool.query(`
    UPDATE app_user_session
    SET last_seen_at = COALESCE(last_seen_at, created_at, NOW())
    WHERE last_seen_at IS NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_app_user_session_user_id
    ON app_user_session(user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_app_user_session_expires_at
    ON app_user_session(expires_at)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_app_user_session_last_seen_at
    ON app_user_session(last_seen_at)
  `);
}

function createMailTransporter() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });
}

async function sendLoginOtpEmail(email, otp) {
  const transporter = createMailTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  if (!transporter || !from) {
    throw new Error("SMTP is not configured");
  }

  await transporter.sendMail({
    from,
    to: email,
    subject: "Your login OTP",
    text: `Your OTP is ${otp}. It expires in 5 minutes.`,
    html: `<p>Your OTP is <strong>${otp}</strong>.</p><p>It expires in 5 minutes.</p>`,
  });
}

async function sendUserCreationOtpEmail(email, otp) {
  const transporter = createMailTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  if (!transporter || !from) {
    throw new Error("SMTP is not configured");
  }

  await transporter.sendMail({
    from,
    to: email,
    subject: "Your account verification OTP",
    text: `Your account verification OTP is ${otp}. It expires in 5 minutes.`,
    html: `<p>Your account verification OTP is <strong>${otp}</strong>.</p><p>It expires in 5 minutes.</p>`,
  });
}

async function sendNewUserDetailsEmail(superUserEmail, user) {
  const transporter = createMailTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  if (!transporter || !from) {
    throw new Error("SMTP is not configured");
  }

  const name = String(user?.name || "").trim() || "(no name)";
  const email = String(user?.email || "").trim() || "(no email)";
  const allowDevices = Number(user?.allow_devices ?? user?.allowDevices ?? 1);
  const validDays = Number(user?.valid_days ?? user?.validDays ?? 30);
  const isActive = Boolean(user?.is_active ?? user?.isActive ?? false);
  const createdAt = user?.created_at ?? user?.createdAt ?? "";
  const expiresAt = user?.expires_at ?? user?.expiresAt ?? "";

  await transporter.sendMail({
    from,
    to: superUserEmail,
    subject: `New user created: ${email}`,
    text: [
      "A new user account was created.",
      "",
      `Name: ${name}`,
      `Email: ${email}`,
      `Status: ${isActive ? "Active" : "Inactive"}`,
      `Allow devices: ${allowDevices}`,
      `Valid days: ${validDays}`,
      `Created at: ${createdAt}`,
      `Expires at: ${expiresAt}`,
      "",
      "Note: The password is not included in this email.",
    ].join("\n"),
    html: [
      "<p>A new user account was created.</p>",
      "<ul>",
      `<li><strong>Name:</strong> ${escapeHtml(name)}</li>`,
      `<li><strong>Email:</strong> ${escapeHtml(email)}</li>`,
      `<li><strong>Status:</strong> ${isActive ? "Active" : "Inactive"}</li>`,
      `<li><strong>Allow devices:</strong> ${allowDevices}</li>`,
      `<li><strong>Valid days:</strong> ${validDays}</li>`,
      `<li><strong>Created at:</strong> ${escapeHtml(String(createdAt))}</li>`,
      `<li><strong>Expires at:</strong> ${escapeHtml(String(expiresAt))}</li>`,
      "</ul>",
      "<p><em>Note: The password is not included in this email.</em></p>",
    ].join(""),
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

app.post("/api/login", async (req, res) => {
  try {
    clearExpiredOtpChallenges();

    const email = normalizeEmail(req.body.email);
    const password = normalizePassword(req.body.password);

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const result = await pool.query(
      `SELECT id, email, password_hash, is_active, allow_devices
       FROM app_user
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Only registered users are allowed",
      });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: "User is inactive",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const otp = generateOtp();
    const challengeId = crypto.randomUUID();
    const expiresAt = Date.now() + OTP_TTL_MS;

    await sendLoginOtpEmail(user.email, otp);

    otpChallenges.set(challengeId, {
      userId: user.id,
      email: user.email,
      allowDevices: Number(user.allow_devices || 1),
      otp,
      expiresAt,
      audience: "user-login",
    });

    return res.status(200).json({
      success: true,
      otpRequired: true,
      challengeId,
      expiresAt,
      message: "Email and password are correct. OTP has been sent to your email.",
    });
  } catch (error) {
    console.error("Login error:", error);

    if (error.message === "SMTP is not configured") {
      return res.status(500).json({
        success: false,
        message: "OTP email is not configured on the server.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

app.post("/api/login/verify-otp", async (req, res) => {
  try {
    clearExpiredOtpChallenges();

    const challengeId = String(req.body.challengeId || "").trim();
    const otp = String(req.body.otp || "").trim();

    if (!challengeId || !otp) {
      return res.status(400).json({
        success: false,
        message: "Challenge id and OTP are required",
      });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 6 digit OTP.",
      });
    }

    const challenge = otpChallenges.get(challengeId);

    if (!challenge || challenge.audience !== "user-login") {
      return res.status(401).json({
        success: false,
        message: "OTP session expired. Please login again.",
      });
    }

    if (challenge.expiresAt <= Date.now()) {
      otpChallenges.delete(challengeId);
      return res.status(401).json({
        success: false,
        message: "OTP expired. Please login again.",
      });
    }

    if (challenge.otp !== otp) {
      return res.status(401).json({
        success: false,
        message: "Invalid OTP. Login not allowed.",
      });
    }

    const deviceId = getOrCreateDeviceId(req, res);
    const tabToken = getTabTokenFromRequest(req);

    const { limitExceeded, session } = await createUserSessionWithLimit(
      { id: challenge.userId, email: challenge.email },
      Number(challenge.allowDevices || 1),
      deviceId,
      tabToken
    );

    if (limitExceeded || !session) {
      return res.status(403).json({
        success: false,
        message: "Device Limits Exceeded please logout from any other devices.",
      });
    }

    otpChallenges.delete(challengeId);
    appendSetCookieHeader(res, buildSessionCookie(USER_SESSION_COOKIE_NAME, session.sessionId));

    return res.status(200).json({
      success: true,
      message: "Logged successfully.",
      user: {
        id: challenge.userId,
        email: challenge.email,
      },
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to verify OTP",
    });
  }
});

app.post("/api/logout", (req, res) => {
  Promise.resolve()
    .then(async () => {
      const cookies = parseCookies(req.headers.cookie);
      const sessionId = String(cookies[USER_SESSION_COOKIE_NAME] || "").trim();

      if (sessionId) {
        const sessionRow = await pool
          .query(
            `SELECT user_id, COALESCE(NULLIF(device_id, ''), session_id) AS device_id
             FROM app_user_session
             WHERE session_id = $1
             LIMIT 1`,
            [sessionId]
          )
          .then((result) => result.rows?.[0] || null)
          .catch(() => null);

        if (sessionRow?.user_id && sessionRow?.device_id) {
          await deleteUserSessionsForDevice(sessionRow.user_id, sessionRow.device_id);
        } else {
          await deleteUserSessionById(sessionId);
        }
      }

      res.setHeader("Set-Cookie", clearSessionCookie(USER_SESSION_COOKIE_NAME));
      res.status(200).json({
        success: true,
        message: "Logged out successfully.",
      });
    })
    .catch((error) => {
      console.error("Logout error:", error);
      res.status(500).json({
        success: false,
        message: "Unable to logout",
      });
    });

  return;
});

app.get("/api/session", async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = String(cookies[USER_SESSION_COOKIE_NAME] || "").trim();

  if (!sessionId) {
    res.setHeader("Set-Cookie", clearSessionCookie(USER_SESSION_COOKIE_NAME));
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "User login required.",
    });
  }

  const result = await pool.query(
    `SELECT s.session_id, s.user_id, s.expires_at, u.email, s.tab_token
     FROM app_user_session s
     JOIN app_user u ON u.id = s.user_id
     WHERE s.session_id = $1
       AND s.expires_at > NOW()
     LIMIT 1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    res.setHeader("Set-Cookie", clearSessionCookie(USER_SESSION_COOKIE_NAME));
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "User login required.",
    });
  }

  const row = result.rows[0];
  const tabToken = getTabTokenFromRequest(req);

  if (!requireTabTokenMatch(tabToken, row.tab_token)) {
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "User login required.",
    });
  }

  try {
    await pool.query(`UPDATE app_user_session SET last_seen_at = NOW() WHERE session_id = $1`, [sessionId]);
  } catch {}

  return res.status(200).json({
    success: true,
    authenticated: true,
    user: {
      id: row.user_id,
      email: row.email,
    },
  });
});

app.post("/api/session/ping", async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = String(cookies[USER_SESSION_COOKIE_NAME] || "").trim();

  if (!sessionId) {
    res.setHeader("Set-Cookie", clearSessionCookie(USER_SESSION_COOKIE_NAME));
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "User login required.",
    });
  }

  const result = await pool.query(
    `SELECT session_id, tab_token
     FROM app_user_session
     WHERE session_id = $1
       AND expires_at > NOW()
     LIMIT 1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    res.setHeader("Set-Cookie", clearSessionCookie(USER_SESSION_COOKIE_NAME));
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "User login required.",
    });
  }

  const row = result.rows[0];
  const tabToken = getTabTokenFromRequest(req);

  if (!requireTabTokenMatch(tabToken, row.tab_token)) {
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "User login required.",
    });
  }

  await pool.query(`UPDATE app_user_session SET last_seen_at = NOW() WHERE session_id = $1`, [sessionId]);

  return res.status(200).json({
    success: true,
    authenticated: true,
  });
});

app.get("/api/transcript/stream", requireUser, async (req, res) => {
  const controller = new AbortController();
  let clientDisconnected = false;

  req.on("close", () => {
    clientDisconnected = true;
    controller.abort();
  });

  try {
    const upstreamResponse = await fetch(`${TRANSCRIPT_BACKEND_BASE_URL}/api/transcript/stream`, {
      headers: {
        Accept: "text/event-stream",
        "x-voxscribe-user-id": String(req.user?.userId || ""),
        "x-voxscribe-tenant-id": String(req.user?.tenantId || ""),
      },
      signal: controller.signal,
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const details = await upstreamResponse.text().catch(() => "");
      return res.status(502).json({
        success: false,
        message: "Transcript backend is unavailable.",
        ...(details ? { details } : {}),
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const reader = upstreamResponse.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done || clientDisconnected) {
          break;
        }

        res.write(Buffer.from(value));
      }
    } catch (error) {
      if (!clientDisconnected && error.name !== "AbortError") {
        console.error("Transcript stream proxy error:", error);
        res.write(`data: ${JSON.stringify({ error: "Transcript stream interrupted." })}\n\n`);
      }
    } finally {
      controller.abort();

      try {
        await reader.cancel();
      } catch {}

      res.end();
    }
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }

    console.error("Transcript backend connection error:", error);
    return res.status(502).json({
      success: false,
      message: "Unable to connect to transcript backend.",
    });
  }
});

app.post("/api/transcript/sessions", requireUser, async (req, res) => {
  try {
    const upstreamResponse = await fetch(`${TRANSCRIPT_BACKEND_BASE_URL}/api/transcript/sessions`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-voxscribe-user-id": String(req.user?.userId || ""),
        "x-voxscribe-tenant-id": String(req.user?.tenantId || ""),
      },
      body: JSON.stringify(req.body || {}),
    });

    const payload = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type");

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    return res.status(upstreamResponse.status).send(payload);
  } catch (error) {
    console.error("Transcript session create proxy error:", error);
    return res.status(502).json({
      success: false,
      message: "Unable to connect to transcript backend.",
    });
  }
});

app.post(
  "/api/transcript/sessions/:sessionId/audio",
  requireUser,
  express.raw({ type: "application/octet-stream", limit: "10mb" }),
  async (req, res) => {
    try {
      const upstreamResponse = await fetch(
        `${TRANSCRIPT_BACKEND_BASE_URL}/api/transcript/sessions/${encodeURIComponent(req.params.sessionId)}/audio`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/octet-stream",
            "x-voxscribe-user-id": String(req.user?.userId || ""),
            "x-voxscribe-tenant-id": String(req.user?.tenantId || ""),
          },
          body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        }
      );

      const payload = await upstreamResponse.text();
      const contentType = upstreamResponse.headers.get("content-type");

      if (contentType) {
        res.setHeader("Content-Type", contentType);
      }

      return res.status(upstreamResponse.status).send(payload);
    } catch (error) {
      console.error("Transcript session audio proxy error:", error);
      return res.status(502).json({
        success: false,
        message: "Unable to connect to transcript backend.",
      });
    }
  }
);

app.post("/api/transcript/sessions/:sessionId/stop", requireUser, async (req, res) => {
  try {
    const upstreamResponse = await fetch(
      `${TRANSCRIPT_BACKEND_BASE_URL}/api/transcript/sessions/${encodeURIComponent(req.params.sessionId)}/stop`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "x-voxscribe-user-id": String(req.user?.userId || ""),
          "x-voxscribe-tenant-id": String(req.user?.tenantId || ""),
        },
      }
    );

    const payload = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type");

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    return res.status(upstreamResponse.status).send(payload);
  } catch (error) {
    console.error("Transcript session stop proxy error:", error);
    return res.status(502).json({
      success: false,
      message: "Unable to connect to transcript backend.",
    });
  }
});

app.get("/api/transcript/sessions/:sessionId/stream", requireUser, async (req, res) => {
  const controller = new AbortController();
  let clientDisconnected = false;
  const sessionId = encodeURIComponent(req.params.sessionId);

  req.on("close", () => {
    clientDisconnected = true;
    controller.abort();
  });

  try {
    const upstreamResponse = await fetch(`${TRANSCRIPT_BACKEND_BASE_URL}/api/transcript/sessions/${sessionId}/stream`, {
      headers: {
        Accept: "text/event-stream",
        "x-voxscribe-user-id": String(req.user?.userId || ""),
        "x-voxscribe-tenant-id": String(req.user?.tenantId || ""),
      },
      signal: controller.signal,
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const details = await upstreamResponse.text().catch(() => "");
      return res.status(502).json({
        success: false,
        message: "Transcript backend is unavailable.",
        ...(details ? { details } : {}),
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const reader = upstreamResponse.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done || clientDisconnected) {
          break;
        }

        res.write(Buffer.from(value));
      }
    } catch (error) {
      if (!clientDisconnected && error.name !== "AbortError") {
        console.error("Transcript session stream proxy error:", error);
        res.write(`data: ${JSON.stringify({ error: "Transcript stream interrupted." })}\n\n`);
      }
    } finally {
      controller.abort();

      try {
        await reader.cancel();
      } catch {}

      res.end();
    }
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }

    console.error("Transcript session backend connection error:", error);
    return res.status(502).json({
      success: false,
      message: "Unable to connect to transcript backend.",
    });
  }
});

async function handleTranscriptWebSocketUpgrade(req, socket, head, requestUrl) {
  req.query = Object.fromEntries(requestUrl.searchParams.entries());
  let session;

  try {
    session = await getUserSessionFromRequest(req);

    if (!session) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
  } catch (error) {
    console.error("Transcript websocket auth error:", error);
    rejectUpgrade(socket, 500, "Internal Server Error");
    return;
  }

  const targetUrl = buildTranscriptWebSocketTargetUrl(requestUrl);
  const transport = targetUrl.protocol === "https:" ? https : http;
  const proxyHeaders = { ...req.headers };

  delete proxyHeaders.host;
  delete proxyHeaders.cookie;

  proxyHeaders["x-voxscribe-user-id"] = String(session?.userId || "");
  proxyHeaders["x-voxscribe-tenant-id"] = String(session?.tenantId || "");

  const proxyRequest = transport.request({
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || undefined,
    method: "GET",
    path: `${targetUrl.pathname}${targetUrl.search}`,
    headers: proxyHeaders,
  });

  proxyRequest.on("upgrade", (proxyResponse, proxySocket, proxyHead) => {
    writeUpgradeResponse(
      socket,
      proxyResponse.statusCode || 101,
      proxyResponse.statusMessage || "Switching Protocols",
      proxyResponse.headers,
    );

    if (head?.length) {
      proxySocket.write(head);
    }

    if (proxyHead?.length) {
      socket.write(proxyHead);
    }

    proxySocket.on("error", (error) => {
      console.error("Transcript websocket upstream error:", error);
      socket.destroy();
    });

    socket.on("error", () => {
      proxySocket.destroy();
    });

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyRequest.on("response", (proxyResponse) => {
    writeUpgradeResponse(
      socket,
      proxyResponse.statusCode || 502,
      proxyResponse.statusMessage || "Bad Gateway",
      proxyResponse.headers,
    );

    proxyResponse.pipe(socket);
  });

  proxyRequest.on("error", (error) => {
    console.error("Transcript websocket proxy error:", error);

    if (!socket.destroyed) {
      rejectUpgrade(socket, 502, "Bad Gateway");
    }
  });

  socket.on("error", () => {
    proxyRequest.destroy();
  });

  proxyRequest.end();
}

app.post("/api/smart-input/query", requireUser, async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (Array.isArray(body.files)) {
      body.files = filterTenantUploadPaths(body.files, req.user?.tenantId, req.user?.userId);
    }
    const upstreamResponse = await fetch(`${TRANSCRIPT_BACKEND_BASE_URL}/api/smart-input/query`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-voxscribe-user-id": String(req.user?.userId || ""),
        "x-voxscribe-tenant-id": String(req.user?.tenantId || ""),
      },
      body: JSON.stringify(body),
    });

    const payload = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type");

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    return res.status(upstreamResponse.status).send(payload);
  } catch (error) {
    console.error("Smart input query proxy error:", error);
    return res.status(502).json({
      success: false,
      message: "Unable to connect to smart input backend.",
    });
  }
});

app.post("/api/smart-input/ingest", requireUser, async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (Array.isArray(body.files)) {
      body.files = filterTenantUploadPaths(body.files, req.user?.tenantId, req.user?.userId);
    }
    const upstreamResponse = await fetch(`${TRANSCRIPT_BACKEND_BASE_URL}/api/smart-input/ingest`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-voxscribe-user-id": String(req.user?.userId || ""),
        "x-voxscribe-tenant-id": String(req.user?.tenantId || ""),
      },
      body: JSON.stringify(body),
    });

    const payload = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type");

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    return res.status(upstreamResponse.status).send(payload);
  } catch (error) {
    console.error("Smart input ingest proxy error:", error);
    return res.status(502).json({
      success: false,
      message: "Unable to connect to smart input backend.",
    });
  }
});

app.get("/api/smart-input/query/:queryId", requireUser, async (req, res) => {
  try {
    const upstreamResponse = await fetch(
      `${TRANSCRIPT_BACKEND_BASE_URL}/api/smart-input/query/${encodeURIComponent(req.params.queryId)}`,
      {
        headers: {
          Accept: "application/json",
          "x-voxscribe-user-id": String(req.user?.userId || ""),
          "x-voxscribe-tenant-id": String(req.user?.tenantId || ""),
        },
      }
    );

    const payload = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type");

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    return res.status(upstreamResponse.status).send(payload);
  } catch (error) {
    console.error("Smart input query status proxy error:", error);
    return res.status(502).json({
      success: false,
      message: "Unable to connect to smart input backend.",
    });
  }
});

app.post("/api/smart-input/stream", requireUser, async (req, res) => {
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  try {
    const body = { ...(req.body || {}) };
    if (Array.isArray(body.files)) {
      body.files = filterTenantUploadPaths(body.files, req.user?.tenantId, req.user?.userId);
    }
    const upstreamResponse = await fetch(`${TRANSCRIPT_BACKEND_BASE_URL}/api/smart-input/stream`, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "x-voxscribe-user-id": String(req.user?.userId || ""),
        "x-voxscribe-tenant-id": String(req.user?.tenantId || ""),
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    const contentType = upstreamResponse.headers.get("content-type") || "text/event-stream";
    res.status(upstreamResponse.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (!upstreamResponse.body) {
      const payload = await upstreamResponse.text();
      res.write(payload);
      res.end();
      return;
    }

    const { Readable } = require("node:stream");
    Readable.fromWeb(upstreamResponse.body).pipe(res);
  } catch (error) {
    if (abortController.signal.aborted) {
      return;
    }

    console.error("Smart input stream proxy error:", error);
    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        message: "Unable to connect to smart input backend.",
      });
      return;
    }
    res.end();
  }
});

app.post("/api/superuser/login", async (req, res) => {
  try {
    clearExpiredOtpChallenges();

    const email = normalizeEmail(req.body.email);
    const password = normalizePassword(req.body.password);
    const superAdmin = getConfiguredSuperAdmin();

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    if (!superAdmin) {
      return res.status(500).json({
        success: false,
        message: "SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD or SUPERADMIN_PASSWORD_HASH must be set in .env",
      });
    }

    if (email !== superAdmin.email) {
      return res.status(401).json({
        success: false,
        message: "Invalid SuperAdmin email or password",
      });
    }

    const isMatch = superAdmin.passwordHash
      ? await bcrypt.compare(password, superAdmin.passwordHash)
      : password === superAdmin.password;

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid SuperAdmin email or password",
      });
    }

    const otp = generateOtp();
    const challengeId = crypto.randomUUID();
    const expiresAt = Date.now() + OTP_TTL_MS;

    await sendLoginOtpEmail(superAdmin.email, otp);

    otpChallenges.set(challengeId, {
      userId: 1,
      email: superAdmin.email,
      otp,
      expiresAt,
      audience: "superadmin",
    });

    return res.status(200).json({
      success: true,
      otpRequired: true,
      challengeId,
      expiresAt,
      message: "SuperAdmin email and password are correct. OTP has been sent to your email.",
    });
  } catch (error) {
    console.error("SuperAdmin login error:", error);

    if (error.message === "SMTP is not configured") {
      return res.status(500).json({
        success: false,
        message: "OTP email is not configured on the server.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to login SuperAdmin",
    });
  }
});

app.post("/api/superuser/verify-otp", async (req, res) => {
  try {
    clearExpiredOtpChallenges();

    const challengeId = String(req.body.challengeId || "").trim();
    const otp = String(req.body.otp || "").trim();

    if (!challengeId || !otp) {
      return res.status(400).json({
        success: false,
        message: "Challenge id and OTP are required",
      });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 6 digit OTP.",
      });
    }

    const challenge = otpChallenges.get(challengeId);

    if (!challenge || challenge.audience !== "superadmin") {
      return res.status(401).json({
        success: false,
        message: "OTP session expired. Please login again.",
      });
    }

    if (challenge.expiresAt <= Date.now()) {
      otpChallenges.delete(challengeId);
      return res.status(401).json({
        success: false,
        message: "OTP expired. Please login again.",
      });
    }

    if (challenge.otp !== otp) {
      return res.status(401).json({
        success: false,
        message: "Invalid OTP. Login not allowed.",
      });
    }

    const tabToken = getTabTokenFromRequest(req);
    const session = createSession(
      superUserSessions,
      {
        id: challenge.userId,
        email: challenge.email,
      },
      tabToken
    );

    otpChallenges.delete(challengeId);
    appendSetCookieHeader(res, buildSessionCookie(SUPERUSER_SESSION_COOKIE_NAME, session.sessionId));

    return res.status(200).json({
      success: true,
      message: "SuperAdmin OTP verified successfully.",
      user: {
        id: challenge.userId,
        email: challenge.email,
      },
    });
  } catch (error) {
    console.error("SuperAdmin verify OTP error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to verify SuperAdmin OTP",
    });
  }
});

app.get("/api/superuser/session", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = String(cookies[SUPERUSER_SESSION_COOKIE_NAME] || "").trim();

  if (!sessionId) {
    res.setHeader("Set-Cookie", clearSessionCookie(SUPERUSER_SESSION_COOKIE_NAME));
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "SuperAdmin login required.",
    });
  }

  const session = getSessionFromRequest(req, SUPERUSER_SESSION_COOKIE_NAME, superUserSessions);

  if (!session) {
    res.setHeader("Set-Cookie", clearSessionCookie(SUPERUSER_SESSION_COOKIE_NAME));
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "SuperAdmin login required.",
    });
  }

  const tabToken = getTabTokenFromRequest(req);

  if (!requireTabTokenMatch(tabToken, session.tabToken)) {
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "SuperAdmin login required.",
    });
  }

  return res.status(200).json({
    success: true,
    authenticated: true,
    user: {
      id: session.userId,
      email: session.email,
    },
  });
});

app.post("/api/superuser/logout", (req, res) => {
  const session = getSessionFromRequest(req, SUPERUSER_SESSION_COOKIE_NAME, superUserSessions);

  if (session) {
    superUserSessions.delete(session.sessionId);
  }

  res.setHeader("Set-Cookie", clearSessionCookie(SUPERUSER_SESSION_COOKIE_NAME));
  return res.status(200).json({
    success: true,
    message: "SuperAdmin logged out successfully.",
  });
});

app.get("/api/users", requireSuperUser, async (req, res) => {
  try {
    await pool.query(`
      UPDATE app_user
      SET is_active = false
      WHERE expires_at IS NOT NULL
        AND expires_at <= NOW()
        AND is_active = true
    `);

    const result = await pool.query(
      `SELECT u.id,
              u.name,
              u.email,
              u.is_active,
              u.created_at,
              u.allow_devices,
              u.valid_days,
              u.login_count,
              u.expires_at,
              (
                SELECT COUNT(DISTINCT COALESCE(NULLIF(s.device_id, ''), s.session_id))
                FROM app_user_session s
                WHERE s.user_id = u.id
                  AND s.expires_at > NOW()
                  AND s.last_seen_at >= NOW() - ($1 * INTERVAL '1 millisecond')
              ) AS active_sessions
       FROM app_user u
       ORDER BY u.id ASC`,
      [SESSION_INACTIVE_TTL_MS]
    );

    return res.status(200).json({
      success: true,
      users: result.rows,
    });
  } catch (error) {
    console.error("List users error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch users",
    });
  }
});

app.post("/api/users/request-otp", requireSuperUser, async (req, res) => {
  try {
    clearExpiredOtpChallenges();

    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const existingUser = await pool.query(
      `SELECT id
       FROM app_user
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "User already exists",
      });
    }

    const otp = generateOtp();
    const challengeId = crypto.randomUUID();
    const expiresAt = Date.now() + OTP_TTL_MS;

    await sendUserCreationOtpEmail(email, otp);

    otpChallenges.set(challengeId, {
      userId: 0,
      email,
      otp,
      expiresAt,
      audience: "user-create",
    });

    return res.status(200).json({
      success: true,
      challengeId,
      expiresAt,
      message: "OTP sent to the new user's email.",
    });
  } catch (error) {
    console.error("Request create-user OTP error:", error);

    if (error.message === "SMTP is not configured") {
      return res.status(500).json({
        success: false,
        message: "OTP email is not configured on the server.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to send OTP",
    });
  }
});

app.post("/api/users", requireSuperUser, async (req, res) => {
  try {
    clearExpiredOtpChallenges();

    const name = normalizeName(req.body.name);
    const email = normalizeEmail(req.body.email);
    const password = normalizePassword(req.body.password);
    const allowDevices = parseAllowedDevices(req.body.allow_devices, 1);
    const isActive = parseActiveValue(req.body.is_active, true);
    const validDays = parseValidDays(req.body.valid_days, 30);
    const challengeId = String(req.body.challenge_id || "").trim();
    const otp = String(req.body.otp || "").trim();

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and password are required",
      });
    }

    if (!challengeId || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email OTP is required",
      });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 6 digit OTP.",
      });
    }

    const existingUser = await pool.query(
      `SELECT id
       FROM app_user
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "User already exists",
      });
    }

    const challenge = otpChallenges.get(challengeId);

    if (!challenge || challenge.audience !== "user-create" || challenge.email !== email) {
      return res.status(401).json({
        success: false,
        message: "OTP session expired or email was changed. Please send OTP again.",
      });
    }

    if (challenge.expiresAt <= Date.now()) {
      otpChallenges.delete(challengeId);
      return res.status(401).json({
        success: false,
        message: "OTP expired. Please send OTP again.",
      });
    }

    if (challenge.otp !== otp) {
      return res.status(401).json({
        success: false,
        message: "Invalid OTP for this email.",
      });
    }

    const passwordHash = await bcrypt.hash(password, PASSWORD_ROUNDS);
    const tenantId = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO app_user (name, email, password_hash, tenant_id, is_active, allow_devices, valid_days, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 * INTERVAL '1 day'))
       RETURNING id, tenant_id, name, email, is_active, created_at, allow_devices, valid_days, login_count, expires_at`,
      [name, email, passwordHash, tenantId, isActive, allowDevices, validDays, validDays]
    );

    otpChallenges.delete(challengeId);
    const superUserEmail = normalizeEmail(req.superUser?.email) || normalizeEmail(getConfiguredSuperAdmin()?.email);

    if (superUserEmail) {
      try {
        await sendNewUserDetailsEmail(superUserEmail, result.rows[0]);
      } catch (error) {
        console.warn("Unable to send new user details email:", error?.message || error);
      }
    }

    return res.status(201).json({
      success: true,
      message: "User created successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Create user error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to create user",
    });
  }
});

app.put("/api/users/:id", requireSuperUser, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const email = normalizeEmail(req.body.email);
    const isActive = parseActiveValue(req.body.is_active, true);
    const validDays = parseValidDays(req.body.valid_days, 30);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid user id is required",
      });
    }

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const existingUser = await pool.query(
      `SELECT id
       FROM app_user
       WHERE LOWER(email) = $1
         AND id <> $2
       LIMIT 1`,
      [email, userId]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Another user already uses this email",
      });
    }

    let result;

    if (isActive) {
      result = await pool.query(
        `UPDATE app_user
         SET email = $1,
             is_active = true,
             valid_days = $2,
             expires_at = NOW() + ($3 * INTERVAL '1 day')
         WHERE id = $4
         RETURNING id, name, email, is_active, created_at, valid_days, expires_at`,
        [email, validDays, validDays, userId]
      );
    } else {
      result = await pool.query(
        `UPDATE app_user
         SET email = $1,
             is_active = false
         WHERE id = $2
         RETURNING id, name, email, is_active, created_at, valid_days, expires_at`,
        [email, userId]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "User updated successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Update user error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to update user",
    });
  }
});

app.put("/api/users/:id/password", requireSuperUser, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const password = normalizePassword(req.body.password);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid user id is required",
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password is required",
      });
    }

    const passwordHash = await bcrypt.hash(password, PASSWORD_ROUNDS);
    const result = await pool.query(
      `UPDATE app_user
       SET password_hash = $1
       WHERE id = $2
       RETURNING id, email, is_active`,
      [passwordHash, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Password reset successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to reset password",
    });
  }
});

app.delete("/api/users/:id", requireSuperUser, async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid user id is required",
      });
    }

    const result = await pool.query(
      `DELETE FROM app_user
       WHERE id = $1
       RETURNING id, email`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Delete user error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to delete user",
    });
  }
});

let server;
let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}`);

  const forceExitTimer = setTimeout(() => {
    console.log("Force exiting after shutdown timeout");
    process.exit(0);
  }, 3000);

  if (!server) {
    clearTimeout(forceExitTimer);
    process.exit(0);
    return;
  }

  server.close(async () => {
    try {
      await pool.end();
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      console.error("Error while closing database pool:", error);
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  });
}

process.once("SIGINT", () => {
  shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

async function startServer() {
  try {
    await ensureDatabaseSetup();
    console.log("Database tables are ready.");

    server = app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

    server.on("upgrade", (req, socket, head) => {
      let requestUrl;

      try {
        requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      } catch {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }

      if (requestUrl.pathname !== "/api/transcript/ws") {
        socket.destroy();
        return;
      }

      void handleTranscriptWebSocketUpgrade(req, socket, head, requestUrl);
    });

    server.on("close", () => {
      console.log("HTTP server closed");
    });
  } catch (error) {
    console.error("Database setup error:", error);
    process.exit(1);
  }
}

startServer();
