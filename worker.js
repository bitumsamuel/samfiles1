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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

/* ---------------- notifications ---------------- */

async function notifyReviewers(env, message, relatedId) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM users WHERE role IN ('admin','tutor') AND approved = 1"
  ).all();
  for (const u of results) {
    await env.DB.prepare(
      "INSERT INTO notifications (user_id, type, message, related_id) VALUES (?, 'duty_review', ?, ?)"
    ).bind(u.id, message, relatedId).run();
  }
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

  const rawText = await apiResp.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    console.error("Anthropic API returned non-JSON:", apiResp.status, rawText.slice(0, 500));
    return json({ reply: "Sorry, the assistant is having trouble right now.", debug: { status: apiResp.status, body: rawText.slice(0, 300) } });
  }

  if (!apiResp.ok) {
    console.error("Anthropic API error:", data);
    return json({ reply: "Sorry, the assistant is having trouble right now.", debug: { status: apiResp.status, error: data } });
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
          "SELECT id, role, name, email, phone, status, profile_photo FROM users WHERE role != 'admin' AND approved = 1 ORDER BY name"
        ).all();
        return json({ users: results });
      }

      const deleteUserMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
      if (deleteUserMatch && request.method === "DELETE") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const id = deleteUserMatch[1];
        const target = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(id).first();
        if (!target) return json({ error: "Not found" }, 404);
        if (target.role === "admin") return json({ error: "Can't delete an admin account this way." }, 400);
        // Clean up everything tied to this person so nothing is left orphaned.
        const assignmentIds = (await env.DB.prepare("SELECT id FROM rota_assignments WHERE student_id = ?").bind(id).all()).results.map((r) => r.id);
        for (const aid of assignmentIds) {
          await env.DB.prepare("DELETE FROM swap_requests WHERE assignment_id = ?").bind(aid).run();
        }
        await env.DB.prepare("DELETE FROM rota_assignments WHERE student_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM duties WHERE student_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM attendance WHERE student_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
        return json({ ok: true });
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
        const includeArchived = url.searchParams.get("include_archived") === "1";
        let query = `SELECT d.*, u.name as student_name FROM duties d JOIN users u ON u.id = d.student_id WHERE 1=1`;
        const binds = [];
        if (!includeArchived) { query += ` AND d.archived = 0`; }
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
          "SELECT id, title, description, due_date, priority, status, completed_at FROM duties WHERE student_id = ? AND archived = 0 ORDER BY due_date ASC"
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

      // ---- Admin: student status tag ----
      const statusMatch = path.match(/^\/api\/admin\/users\/(\d+)\/status$/);
      if (statusMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        if (!["active", "probation", "internship"].includes(b.status)) return json({ error: "Invalid status" }, 400);
        await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(b.status, statusMatch[1]).run();
        return json({ ok: true });
      }

      // ---- Admin: duty types ----
      if (path === "/api/admin/duty-types" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        if (!b.name) return json({ error: "Name is required" }, 400);
        const checklist = Array.isArray(b.checklist) ? b.checklist.filter(Boolean) : [];
        const res = await env.DB.prepare(
          "INSERT INTO duty_types (name, description, checklist_json) VALUES (?, ?, ?)"
        ).bind(b.name, b.description || null, JSON.stringify(checklist)).run();
        return json({ id: res.meta.last_row_id });
      }

      const deleteDutyTypeMatch = path.match(/^\/api\/admin\/duty-types\/(\d+)$/);
      if (deleteDutyTypeMatch && request.method === "DELETE") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const inUse = await env.DB.prepare("SELECT id FROM rota_assignments WHERE duty_type_id = ? LIMIT 1").bind(deleteDutyTypeMatch[1]).first();
        if (inUse) return json({ error: "Can't delete a duty type that already has assignments. Remove those first, or just stop using it going forward." }, 400);
        await env.DB.prepare("DELETE FROM duty_types WHERE id = ?").bind(deleteDutyTypeMatch[1]).run();
        return json({ ok: true });
      }

      if (path === "/api/admin/duty-types" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare("SELECT * FROM duty_types ORDER BY name").all();
        return json({ duty_types: results.map((d) => ({ ...d, checklist: JSON.parse(d.checklist_json || "[]") })) });
      }

      // ---- Admin: generate rota for a multi-week block ----
      // Fair round-robin across weekdays: for each Mon-Fri day in the block, for each
      // selected duty type, assign whichever active student has the fewest total past
      // assignments (ties broken by whoever was assigned longest ago). Never double-books
      // the same student on the same day across duty types.
      if (path === "/api/admin/rota/generate" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        const weeks = Math.min(Math.max(Number(b.weeks) || 1, 1), 12); // cap at 12 weeks per click, sanity limit
        if (!b.start_date || !Array.isArray(b.duty_type_ids) || b.duty_type_ids.length === 0) {
          return json({ error: "start_date and duty_type_ids are required" }, 400);
        }
        const startDate = new Date(b.start_date + "T00:00:00Z");
        if (isNaN(startDate.getTime())) return json({ error: "Invalid start_date" }, 400);

        const { results: students } = await env.DB.prepare(
          "SELECT id FROM users WHERE role = 'student' AND approved = 1 AND status = 'active' ORDER BY id"
        ).all();
        if (students.length === 0) return json({ error: "No active students available to assign." }, 400);

        const { results: counts } = await env.DB.prepare(
          "SELECT student_id, COUNT(*) as cnt, MAX(assignment_date) as last_date FROM rota_assignments GROUP BY student_id"
        ).all();
        const countMap = new Map(students.map((s) => [s.id, { cnt: 0, last_date: "" }]));
        counts.forEach((c) => countMap.set(c.student_id, { cnt: c.cnt, last_date: c.last_date || "" }));

        function toISODate(d) { return d.toISOString().slice(0, 10); }
        function mondayOf(d) {
          const day = d.getUTCDay(); // 0=Sun..6=Sat
          const diff = (day === 0 ? -6 : 1) - day;
          const monday = new Date(d);
          monday.setUTCDate(d.getUTCDate() + diff);
          return monday;
        }

        const created = [];
        for (let w = 0; w < weeks; w++) {
          for (let day = 0; day < 5; day++) { // Mon-Fri only
            const current = new Date(startDate);
            current.setUTCDate(startDate.getUTCDate() + w * 7 + day);
            const dateStr = toISODate(current);
            const weekStartStr = toISODate(mondayOf(current));
            const assignedToday = new Set();

            for (const dutyTypeId of b.duty_type_ids) {
              const eligible = students.filter((s) => !assignedToday.has(s.id));
              if (eligible.length === 0) continue; // not enough students to cover every duty this day
              eligible.sort((a, b2) => {
                const ca = countMap.get(a.id), cb = countMap.get(b2.id);
                if (ca.cnt !== cb.cnt) return ca.cnt - cb.cnt;
                return ca.last_date < cb.last_date ? -1 : ca.last_date > cb.last_date ? 1 : a.id - b2.id;
              });
              const chosen = eligible[0];
              await env.DB.prepare(
                "INSERT INTO rota_assignments (duty_type_id, student_id, week_start, assignment_date) VALUES (?, ?, ?, ?)"
              ).bind(dutyTypeId, chosen.id, weekStartStr, dateStr).run();
              countMap.set(chosen.id, { cnt: countMap.get(chosen.id).cnt + 1, last_date: dateStr });
              assignedToday.add(chosen.id);
              created.push({ duty_type_id: dutyTypeId, student_id: chosen.id, date: dateStr });
            }
          }
        }
        return json({ created, count: created.length });
      }

      if (path === "/api/admin/rota" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const week = url.searchParams.get("week");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const includeArchived = url.searchParams.get("include_archived") === "1";
        let query = `SELECT r.*, u.name as student_name, dt.name as duty_name, dt.checklist_json
                      FROM rota_assignments r
                      JOIN users u ON u.id = r.student_id
                      JOIN duty_types dt ON dt.id = r.duty_type_id WHERE 1=1`;
        const binds = [];
        if (!includeArchived) { query += ` AND r.archived = 0`; }
        if (week) { query += ` AND r.week_start = ?`; binds.push(week); }
        if (from) { query += ` AND r.assignment_date >= ?`; binds.push(from); }
        if (to) { query += ` AND r.assignment_date <= ?`; binds.push(to); }
        query += ` ORDER BY r.assignment_date ASC, dt.name`;
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json({ assignments: results.map((r) => ({ ...r, checklist: JSON.parse(r.checklist_json || "[]"), checklist_state: JSON.parse(r.checklist_state || "[]") })) });
      }

      // Direct "Mark Done" — admin/tutor completes a duty without requiring a student photo
      const rateMatch = path.match(/^\/api\/admin\/rota\/(\d+)\/rate$/);
      if (rateMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        if (b.rating && (b.rating < 1 || b.rating > 5)) return json({ error: "Rating must be 1-5" }, 400);
        await env.DB.prepare(
          `UPDATE rota_assignments SET status = 'completed', checklist_state = ?, rating = ?, rated_by = ?, rated_at = CURRENT_TIMESTAMP,
           review_status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(JSON.stringify(b.checklist_state || []), b.rating || null, auth.id, auth.id, rateMatch[1]).run();
        return json({ ok: true });
      }

      // Approve a student's submitted proof photo — completes the duty
      const approveRotaMatch = path.match(/^\/api\/admin\/rota\/(\d+)\/approve$/);
      if (approveRotaMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json().catch(() => ({}));
        if (b.rating && (b.rating < 1 || b.rating > 5)) return json({ error: "Rating must be 1-5" }, 400);
        await env.DB.prepare(
          `UPDATE rota_assignments SET status = 'completed', checklist_state = ?, rating = ?, rated_by = ?, rated_at = CURRENT_TIMESTAMP,
           review_status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND review_status = 'pending_review'`
        ).bind(JSON.stringify(b.checklist_state || []), b.rating || null, auth.id, auth.id, approveRotaMatch[1]).run();
        return json({ ok: true });
      }

      // Reject a student's submitted proof photo — sends it back to be redone
      const rejectRotaMatch = path.match(/^\/api\/admin\/rota\/(\d+)\/reject$/);
      if (rejectRotaMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json().catch(() => ({}));
        await env.DB.prepare(
          `UPDATE rota_assignments SET status = 'assigned', review_status = 'rejected', review_note = ?,
           reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, photo_base64 = NULL WHERE id = ? AND review_status = 'pending_review'`
        ).bind(b.note || null, auth.id, rejectRotaMatch[1]).run();
        return json({ ok: true });
      }

      // ---- Swap board (student/tutor) ----
      if (path === "/api/me/rota" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          `SELECT r.*, dt.name as duty_name, dt.checklist_json FROM rota_assignments r
           JOIN duty_types dt ON dt.id = r.duty_type_id
           WHERE r.student_id = ? AND r.archived = 0 ORDER BY r.assignment_date DESC`
        ).bind(auth.id).all();
        return json({ assignments: results.map((r) => ({ ...r, checklist: JSON.parse(r.checklist_json || "[]") })) });
      }

      // Student submits (or resubmits, after a rejection) proof-of-completion photo
      const submitProofMatch = path.match(/^\/api\/me\/rota\/(\d+)\/submit-proof$/);
      if (submitProofMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const assignment = await env.DB.prepare("SELECT * FROM rota_assignments WHERE id = ? AND student_id = ?")
          .bind(submitProofMatch[1], auth.id).first();
        if (!assignment) return json({ error: "Not found" }, 404);
        if (assignment.status === "completed") return json({ error: "This duty is already marked complete." }, 400);
        const b = await request.json();
        if (!b.photo_base64) return json({ error: "A photo is required." }, 400);
        await env.DB.prepare(
          `UPDATE rota_assignments SET photo_base64 = ?, submitted_at = CURRENT_TIMESTAMP, review_status = 'pending_review', review_note = NULL WHERE id = ?`
        ).bind(b.photo_base64, assignment.id).run();
        const dutyType = await env.DB.prepare("SELECT name FROM duty_types WHERE id = ?").bind(assignment.duty_type_id).first();
        await notifyReviewers(
          env,
          `${auth.name} submitted proof for "${dutyType ? dutyType.name : "a duty"}" (${assignment.assignment_date}) — awaiting review.`,
          assignment.id
        );
        return json({ ok: true });
      }

      const swapRequestMatch = path.match(/^\/api\/me\/rota\/(\d+)\/swap-request$/);
      if (swapRequestMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const assignment = await env.DB.prepare("SELECT * FROM rota_assignments WHERE id = ? AND student_id = ?")
          .bind(swapRequestMatch[1], auth.id).first();
        if (!assignment) return json({ error: "Not found" }, 404);
        const b = await request.json().catch(() => ({}));
        await env.DB.prepare("INSERT INTO swap_requests (assignment_id, requested_by, reason) VALUES (?, ?, ?)")
          .bind(assignment.id, auth.id, b.reason || null).run();
        await env.DB.prepare("UPDATE rota_assignments SET status = 'swap_requested' WHERE id = ?").bind(assignment.id).run();
        return json({ ok: true });
      }

      if (path === "/api/swap-board" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          `SELECT sw.*, r.week_start, r.assignment_date, r.student_id as original_student_id, u.name as original_student_name, dt.name as duty_name
           FROM swap_requests sw
           JOIN rota_assignments r ON r.id = sw.assignment_id
           JOIN users u ON u.id = r.student_id
           JOIN duty_types dt ON dt.id = r.duty_type_id
           WHERE sw.status = 'open' ORDER BY sw.created_at DESC`
        ).all();
        return json({ swaps: results });
      }

      const swapAcceptMatch = path.match(/^\/api\/swap-board\/(\d+)\/accept$/);
      if (swapAcceptMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const swap = await env.DB.prepare("SELECT * FROM swap_requests WHERE id = ? AND status = 'open'").bind(swapAcceptMatch[1]).first();
        if (!swap) return json({ error: "This swap is no longer available." }, 404);
        if (swap.requested_by === auth.id) return json({ error: "You can't accept your own swap request." }, 400);
        await env.DB.prepare(
          `UPDATE rota_assignments SET student_id = ?, status = 'assigned', photo_base64 = NULL, submitted_at = NULL, review_status = NULL, review_note = NULL WHERE id = ?`
        ).bind(auth.id, swap.assignment_id).run();
        await env.DB.prepare("UPDATE swap_requests SET status = 'accepted', accepted_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(auth.id, swap.id).run();
        return json({ ok: true });
      }

      // ---- Announcements ----
      if (path === "/api/admin/announcements" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        if (!b.title || !b.body) return json({ error: "Title and body are required" }, 400);
        const res = await env.DB.prepare("INSERT INTO announcements (title, body, created_by) VALUES (?, ?, ?)")
          .bind(b.title, b.body, auth.id).run();
        return json({ id: res.meta.last_row_id });
      }

      if (path === "/api/announcements" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin", "student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare("SELECT * FROM announcements ORDER BY created_at DESC LIMIT 20").all();
        return json({ announcements: results });
      }

      // ---- Student / tutor: own profile + attendance ----
      if (path === "/api/me" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const user = await env.DB.prepare("SELECT profile_photo FROM users WHERE id = ?").bind(auth.id).first();
        return json({ id: auth.id, name: auth.name, email: auth.email, role: auth.role, profile_photo: user ? user.profile_photo : null });
      }

      // Student/tutor: upload or replace their own profile picture
      if (path === "/api/me/profile-photo" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        if (!b.photo_base64) return json({ error: "A photo is required." }, 400);
        await env.DB.prepare("UPDATE users SET profile_photo = ? WHERE id = ?").bind(b.photo_base64, auth.id).run();
        return json({ ok: true });
      }

      if (path === "/api/me/attendance" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT date, status, note FROM attendance WHERE student_id = ? ORDER BY date DESC"
        ).bind(auth.id).all();
        return json({ attendance: results });
      }

      // ---- Admin: clear (archive) duty history ----
      // Archives everything currently marked completed so it drops out of the working views,
      // while keeping the rows in the database for later reference if ever needed.
      if (path === "/api/admin/duties/archive-completed" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const res = await env.DB.prepare("UPDATE duties SET archived = 1 WHERE status = 'completed' AND archived = 0").run();
        return json({ ok: true, archived: res.meta.changes });
      }

      if (path === "/api/admin/rota/archive-completed" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const res = await env.DB.prepare("UPDATE rota_assignments SET archived = 1 WHERE status = 'completed' AND archived = 0").run();
        return json({ ok: true, archived: res.meta.changes });
      }

      // ---- Grade & Progress Tracker ----
      if (path === "/api/admin/grades" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const studentFilter = url.searchParams.get("student_id");
        let query = "SELECT g.*, u.name as student_name FROM grades g JOIN users u ON u.id = g.student_id WHERE 1=1";
        const binds = [];
        if (studentFilter) { query += " AND g.student_id = ?"; binds.push(studentFilter); }
        query += " ORDER BY u.name, g.course_name";
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json({ grades: results });
      }

      // Create or update a course grade/progress row for a student (upsert by id if provided)
      if (path === "/api/admin/grades" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        if (!b.student_id || !b.course_name) return json({ error: "student_id and course_name are required" }, 400);
        if (b.progress_percent != null && (b.progress_percent < 0 || b.progress_percent > 100)) {
          return json({ error: "progress_percent must be between 0 and 100" }, 400);
        }
        if (b.id) {
          await env.DB.prepare(
            "UPDATE grades SET course_name = ?, grade = ?, progress_percent = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).bind(b.course_name, b.grade || null, b.progress_percent ?? null, auth.id, b.id).run();
          return json({ id: b.id });
        }
        const res = await env.DB.prepare(
          "INSERT INTO grades (student_id, course_name, grade, progress_percent, updated_by) VALUES (?, ?, ?, ?, ?)"
        ).bind(b.student_id, b.course_name, b.grade || null, b.progress_percent ?? null, auth.id).run();
        return json({ id: res.meta.last_row_id });
      }

      const deleteGradeMatch = path.match(/^\/api\/admin\/grades\/(\d+)$/);
      if (deleteGradeMatch && request.method === "DELETE") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        await env.DB.prepare("DELETE FROM grades WHERE id = ?").bind(deleteGradeMatch[1]).run();
        return json({ ok: true });
      }

      if (path === "/api/me/grades" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, course_name, grade, progress_percent, updated_at FROM grades WHERE student_id = ? ORDER BY course_name"
        ).bind(auth.id).all();
        return json({ grades: results });
      }

      // ---- Student alarms/reminders ----
      if (path === "/api/me/alarms" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT * FROM alarms WHERE student_id = ? ORDER BY time ASC"
        ).bind(auth.id).all();
        return json({ alarms: results.map((a) => ({ ...a, days: JSON.parse(a.days_json || "[]") })) });
      }

      if (path === "/api/me/alarms" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        if (!b.label || !b.time) return json({ error: "label and time are required" }, 400);
        const days = Array.isArray(b.days) && b.days.length ? b.days : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const res = await env.DB.prepare(
          "INSERT INTO alarms (student_id, label, time, days_json) VALUES (?, ?, ?, ?)"
        ).bind(auth.id, b.label, b.time, JSON.stringify(days)).run();
        return json({ id: res.meta.last_row_id });
      }

      const toggleAlarmMatch = path.match(/^\/api\/me\/alarms\/(\d+)\/toggle$/);
      if (toggleAlarmMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const alarm = await env.DB.prepare("SELECT * FROM alarms WHERE id = ? AND student_id = ?").bind(toggleAlarmMatch[1], auth.id).first();
        if (!alarm) return json({ error: "Not found" }, 404);
        await env.DB.prepare("UPDATE alarms SET enabled = ? WHERE id = ?").bind(alarm.enabled ? 0 : 1, alarm.id).run();
        return json({ ok: true, enabled: alarm.enabled ? 0 : 1 });
      }

      const deleteAlarmMatch = path.match(/^\/api\/me\/alarms\/(\d+)$/);
      if (deleteAlarmMatch && request.method === "DELETE") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        await env.DB.prepare("DELETE FROM alarms WHERE id = ? AND student_id = ?").bind(deleteAlarmMatch[1], auth.id).run();
        return json({ ok: true });
      }

      // ---- Notifications (admin/tutor: e.g. duties awaiting review) ----
      if (path === "/api/admin/notifications" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40"
        ).bind(auth.id).all();
        return json({ notifications: results });
      }

      const readNotifMatch = path.match(/^\/api\/admin\/notifications\/(\d+)\/read$/);
      if (readNotifMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        await env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?").bind(readNotifMatch[1], auth.id).run();
        return json({ ok: true });
      }

      if (path === "/api/admin/notifications/read-all" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        await env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0").bind(auth.id).run();
        return json({ ok: true });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "Server error", detail: String(err) }, 500);
    }
  },
};
