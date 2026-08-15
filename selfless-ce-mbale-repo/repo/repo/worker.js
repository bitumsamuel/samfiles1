/**
 * Selfless CE — Backend Worker
 * Handles: AI chat assistant, login/signup (with admin approval), password reset,
 * duty tracking, and attendance tracking.
 *
 * Payments/MTN MoMo support has been removed — this Worker only manages people,
 * duties, and attendance now.
 */

const ALLOWED_ORIGIN = "*"; // Production: replace with your exact site URL.

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

/* ---------------- crypto helpers (Web Crypto, no libraries needed) ---------------- */

function b64url(bytes) {
  let str = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return b64url(bits);
}

async function signJWT(payload, secret, expiresInSeconds = 60 * 60 * 12) {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const encHeader = b64url(JSON.stringify(header));
  const encPayload = b64url(JSON.stringify(fullPayload));
  const data = `${encHeader}.${encPayload}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

async function verifyJWT(token, secret) {
  try {
    const [h, p, s] = token.split(".");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(b64urlDecode(s), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${h}.${p}`));
    if (!valid) return null;
    const payload = JSON.parse(b64urlDecode(p));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function requireAuth(request, env, roles) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;
  if (roles && !roles.includes(payload.role)) return null;
  return payload; // { id, role, name, email, exp }
}

/* ---------------- chat assistant ---------------- */

const SYSTEM_PROMPT = `You are the friendly AI assistant for Selfless CE, a nonprofit in Uganda
that helps young adults become self-sufficient through education (BYU Pathway Worldwide),
mentorship, and technology access. Programs: College Assistance Program (CAP), Missionary
Assistance Program (MAP), Temple Attendance Assistance (TAA). The Mbale Tech Center is
managed by Kevin Wangoda. Be warm, concise, and honest when you don't know something —
point visitors to the Contact form for specifics.`;

async function handleChat(request, env) {
  const { messages } = await request.json();
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "No messages provided" }, 400);
  }
  const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: messages.slice(-20),
    }),
  });
  const data = await apiResp.json();
  if (!apiResp.ok) {
    console.error("Anthropic API error:", data);
    return json({ reply: "Sorry, the assistant is having trouble right now." });
  }
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return json({ reply: textBlock ? textBlock.text : "Sorry, I couldn't generate a reply." });
}

/* ---------------- router ---------------- */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Chat assistant
      if (path === "/" || path === "/chat") {
        if (request.method !== "POST") return json({ error: "Not found" }, 404);
        return await handleChat(request, env);
      }

      // ---- One-time bootstrap: creates the first admin account ----
      if (path === "/api/bootstrap-admin" && request.method === "POST") {
        const b = await request.json();
        if (!env.BOOTSTRAP_KEY || b.bootstrapKey !== env.BOOTSTRAP_KEY) return json({ error: "Unauthorized" }, 401);
        const existing = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first();
        if (existing) return json({ error: "An admin already exists." }, 400);
        const salt = crypto.randomUUID();
        const hash = await hashPassword(b.password, salt);
        const res = await env.DB.prepare(
          `INSERT INTO users (role, name, email, password_hash, password_salt, approved) VALUES ('admin', ?, ?, ?, ?, 1)`
        ).bind(b.name, b.email, hash, salt).run();
        return json({ id: res.meta.last_row_id, message: "Admin created. You can now log in." });
      }

      // ---- Public: self-signup (goes into a pending queue) ----
      if (path === "/api/auth/signup" && request.method === "POST") {
        const b = await request.json();
        if (!b.name || !b.email || !b.password || !["student", "tutor"].includes(b.role)) {
          return json({ error: "Name, email, password, and a valid role (student or tutor) are required." }, 400);
        }
        const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(b.email).first();
        if (existing) return json({ error: "An account with this email already exists." }, 400);
        const salt = crypto.randomUUID();
        const hash = await hashPassword(b.password, salt);
        await env.DB.prepare(
          `INSERT INTO users (role, name, email, phone, password_hash, password_salt, approved) VALUES (?, ?, ?, ?, ?, ?, 0)`
        ).bind(b.role, b.name, b.email, b.phone || null, hash, salt).run();
        return json({ message: "Account created. An admin needs to approve it before you can log in." });
      }

      // ---- Auth ----
      if (path === "/api/auth/login" && request.method === "POST") {
        const { email, password } = await request.json();
        const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
        if (!user) return json({ error: "Invalid email or password" }, 401);
        const hash = await hashPassword(password, user.password_salt);
        if (hash !== user.password_hash) return json({ error: "Invalid email or password" }, 401);
        if (!user.approved) return json({ error: "Your account is pending admin approval." }, 403);
        const token = await signJWT({ id: user.id, role: user.role, name: user.name, email: user.email }, env.JWT_SECRET);
        return json({ token, role: user.role, name: user.name, id: user.id });
      }

      // ---- Admin: pending signups ----
      if (path === "/api/admin/users/pending" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, role, name, email, phone, created_at FROM users WHERE approved = 0 ORDER BY created_at ASC"
        ).all();
        return json({ users: results });
      }

      const approveMatch = path.match(/^\/api\/admin\/users\/(\d+)\/approve$/);
      if (approveMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        await env.DB.prepare("UPDATE users SET approved = 1 WHERE id = ?").bind(approveMatch[1]).run();
        return json({ ok: true });
      }

      const rejectMatch = path.match(/^\/api\/admin\/users\/(\d+)\/reject$/);
      if (rejectMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        await env.DB.prepare("DELETE FROM users WHERE id = ? AND approved = 0").bind(rejectMatch[1]).run();
        return json({ ok: true });
      }

      // ---- Admin: reset a user's password ----
      const resetMatch = path.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
      if (resetMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        if (!b.password || b.password.length < 6) return json({ error: "New password must be at least 6 characters." }, 400);
        const salt = crypto.randomUUID();
        const hash = await hashPassword(b.password, salt);
        await env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?")
          .bind(hash, salt, resetMatch[1]).run();
        return json({ ok: true });
      }

      // ---- Admin: manage users (students/tutors) ----
      if (path === "/api/admin/users" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        const salt = crypto.randomUUID();
        const hash = await hashPassword(b.password, salt);
        const res = await env.DB.prepare(
          `INSERT INTO users (role, name, email, phone, password_hash, password_salt, approved) VALUES (?, ?, ?, ?, ?, ?, 1)`
        ).bind(b.role, b.name, b.email, b.phone || null, hash, salt).run();
        return json({ id: res.meta.last_row_id });
      }

      if (path === "/api/admin/users" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, role, name, email, phone FROM users WHERE role != 'admin' AND approved = 1 ORDER BY name"
        ).all();
        return json({ users: results });
      }

      // ---- Admin: duties ----
      if (path === "/api/admin/duties" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        if (!b.student_id || !b.title || !b.due_date) return json({ error: "student_id, title, and due_date are required" }, 400);
        const res = await env.DB.prepare(
          `INSERT INTO duties (student_id, title, description, due_date, priority, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(b.student_id, b.title, b.description || null, b.due_date, b.priority || "standard", auth.id).run();
        return json({ id: res.meta.last_row_id });
      }

      if (path === "/api/admin/duties" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const statusFilter = url.searchParams.get("status"); // pending | completed | overdue
        const studentFilter = url.searchParams.get("student_id");
        let query = `SELECT d.*, u.name as student_name FROM duties d JOIN users u ON u.id = d.student_id WHERE 1=1`;
        const binds = [];
        if (studentFilter) { query += ` AND d.student_id = ?`; binds.push(studentFilter); }
        if (statusFilter === "completed") { query += ` AND d.status = 'completed'`; }
        else if (statusFilter === "pending") { query += ` AND d.status = 'pending' AND d.due_date >= date('now')`; }
        else if (statusFilter === "overdue") { query += ` AND d.status = 'pending' AND d.due_date < date('now')`; }
        query += ` ORDER BY d.due_date ASC`;
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        const withComputedStatus = results.map((d) => ({
          ...d,
          computed_status: d.status === "completed" ? "completed" : (d.due_date < new Date().toISOString().slice(0, 10) ? "overdue" : "pending"),
        }));
        return json({ duties: withComputedStatus });
      }

      // ---- Student: duties ----
      if (path === "/api/me/duties" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, title, description, due_date, priority, status, completed_at FROM duties WHERE student_id = ? ORDER BY due_date ASC"
        ).bind(auth.id).all();
        const withComputedStatus = results.map((d) => ({
          ...d,
          computed_status: d.status === "completed" ? "completed" : (d.due_date < new Date().toISOString().slice(0, 10) ? "overdue" : "pending"),
        }));
        return json({ duties: withComputedStatus });
      }

      const dutyDetailMatch = path.match(/^\/api\/me\/duties\/(\d+)$/);
      if (dutyDetailMatch && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const duty = await env.DB.prepare("SELECT * FROM duties WHERE id = ? AND student_id = ?").bind(dutyDetailMatch[1], auth.id).first();
        if (!duty) return json({ error: "Not found" }, 404);
        return json({ duty });
      }

      const dutyCompleteMatch = path.match(/^\/api\/me\/duties\/(\d+)\/complete$/);
      if (dutyCompleteMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const id = dutyCompleteMatch[1];
        const b = await request.json().catch(() => ({}));
        // photo_base64, if provided, should be a small data URL (e.g. under ~1.5MB) — D1 has a per-row size limit.
        const duty = await env.DB.prepare("SELECT id FROM duties WHERE id = ? AND student_id = ?").bind(id, auth.id).first();
        if (!duty) return json({ error: "Not found" }, 404);
        await env.DB.prepare(
          "UPDATE duties SET status = 'completed', photo_base64 = COALESCE(?, photo_base64), completed_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(b.photo_base64 || null, id).run();
        return json({ status: "completed" });
      }

      // ---- Admin: attendance ----
      if (path === "/api/admin/attendance" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        if (!b.student_id || !b.date || !b.status) return json({ error: "student_id, date, and status are required" }, 400);
        await env.DB.prepare(
          `INSERT INTO attendance (student_id, date, status, note, marked_by)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, note = excluded.note, marked_by = excluded.marked_by`
        ).bind(b.student_id, b.date, b.status, b.note || null, auth.id).run();
        return json({ ok: true });
      }

      if (path === "/api/admin/attendance" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const studentFilter = url.searchParams.get("student_id");
        const dateFilter = url.searchParams.get("date");
        let query = `SELECT a.*, u.name as student_name FROM attendance a JOIN users u ON u.id = a.student_id WHERE 1=1`;
        const binds = [];
        if (studentFilter) { query += ` AND a.student_id = ?`; binds.push(studentFilter); }
        if (dateFilter) { query += ` AND a.date = ?`; binds.push(dateFilter); }
        query += ` ORDER BY a.date DESC`;
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json({ attendance: results });
      }

      // ---- Student / tutor: own profile + attendance ----
      if (path === "/api/me" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        return json({ id: auth.id, name: auth.name, email: auth.email, role: auth.role });
      }

      if (path === "/api/me/attendance" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT date, status, note FROM attendance WHERE student_id = ? ORDER BY date DESC"
        ).bind(auth.id).all();
        return json({ attendance: results });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "Server error", detail: String(err) }, 500);
    }
  },
};
