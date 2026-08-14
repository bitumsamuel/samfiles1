/**
 * Selfless CE — Backend Worker
 * Handles: AI chat assistant, login, and the student/tutor finance tracker
 * (including real MTN MoMo disbursements). Deploy + setup steps are in README.md.
 *
 * This moves real money and stores real people's financial details.
 * Read the "Security & Compliance" section of README.md before going live.
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

/* ---------------- MTN MoMo disbursement ---------------- */

async function momoDisburse(env, { amount, currency, phone, externalId, note }) {
  const tokenResp = await fetch(`${env.MOMO_BASE_URL}/disbursement/token/`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.MOMO_DISBURSEMENT_API_USER}:${env.MOMO_DISBURSEMENT_API_KEY}`),
      "Ocp-Apim-Subscription-Key": env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY,
      "X-Target-Environment": env.MOMO_TARGET_ENVIRONMENT,
    },
  });
  if (!tokenResp.ok) {
    const t = await tokenResp.text();
    throw new Error("MoMo token request failed: " + t);
  }
  const { access_token } = await tokenResp.json();
  const referenceId = crypto.randomUUID();

  const transferResp = await fetch(`${env.MOMO_BASE_URL}/disbursement/v1_0/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
      "Ocp-Apim-Subscription-Key": env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY,
      "X-Reference-Id": referenceId,
      "X-Target-Environment": env.MOMO_TARGET_ENVIRONMENT,
      ...(env.MOMO_CALLBACK_URL ? { "X-Callback-Url": env.MOMO_CALLBACK_URL } : {}),
    },
    body: JSON.stringify({
      amount: String(amount),
      currency,
      externalId,
      payee: { partyIdType: "MSISDN", partyId: phone },
      payerMessage: note || "Selfless CE payment",
      payeeNote: note || "Selfless CE payment",
    }),
  });

  // MTN returns 202 Accepted with no body when the transfer request is accepted;
  // the real result arrives async via callback or by polling the reference ID.
  if (transferResp.status !== 202) {
    const t = await transferResp.text();
    throw new Error(`MoMo transfer request failed (${transferResp.status}): ${t}`);
  }
  return { referenceId, status: "processing" };
}

async function momoCheckStatus(env, referenceId) {
  const tokenResp = await fetch(`${env.MOMO_BASE_URL}/disbursement/token/`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.MOMO_DISBURSEMENT_API_USER}:${env.MOMO_DISBURSEMENT_API_KEY}`),
      "Ocp-Apim-Subscription-Key": env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY,
      "X-Target-Environment": env.MOMO_TARGET_ENVIRONMENT,
    },
  });
  const { access_token } = await tokenResp.json();
  const statusResp = await fetch(`${env.MOMO_BASE_URL}/disbursement/v1_0/transfer/${referenceId}`, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Ocp-Apim-Subscription-Key": env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY,
      "X-Target-Environment": env.MOMO_TARGET_ENVIRONMENT,
    },
  });
  return statusResp.json(); // { status: "SUCCESSFUL" | "FAILED" | "PENDING", ... }
}

/* ---------------- chat assistant (unchanged behaviour) ---------------- */

const SYSTEM_PROMPT = `You are the friendly AI assistant for Selfless CE, a nonprofit in Uganda
that helps young adults become self-sufficient through education (BYU Pathway Worldwide),
mentorship, and technology access. Programs: College Assistance Program (CAP), Missionary
Assistance Program (MAP), Temple Attendance Assistance (TAA). The Mbale Tech Center is
managed by Kevin Wangoda. Be warm, concise, and honest when you don't know something —
point visitors to the Contact form for specifics like exact balances or payment status.`;

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
      // Existing chat assistant
      if (path === "/" || path === "/chat") {
        if (request.method !== "POST") return json({ error: "Not found" }, 404);
        return await handleChat(request, env);
      }

      // One-time setup route: creates the first admin account. Guarded by a secret
      // key you set once via `wrangler secret put BOOTSTRAP_KEY`, then delete this
      // block (or just stop using it) once your admin account exists.
      if (path === "/api/bootstrap-admin" && request.method === "POST") {
        const b = await request.json();
        if (!env.BOOTSTRAP_KEY || b.bootstrapKey !== env.BOOTSTRAP_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }
        const existing = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first();
        if (existing) return json({ error: "An admin already exists." }, 400);
        const salt = crypto.randomUUID();
        const hash = await hashPassword(b.password, salt);
        const res = await env.DB.prepare(
          `INSERT INTO users (role, name, email, password_hash, password_salt) VALUES ('admin', ?, ?, ?, ?)`
        ).bind(b.name, b.email, hash, salt).run();
        return json({ id: res.meta.last_row_id, message: "Admin created. You can now log in." });
      }

      // ---- Auth ----
      if (path === "/api/auth/login" && request.method === "POST") {
        const { email, password } = await request.json();
        const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
        if (!user) return json({ error: "Invalid email or password" }, 401);
        const hash = await hashPassword(password, user.password_salt);
        if (hash !== user.password_hash) return json({ error: "Invalid email or password" }, 401);
        const token = await signJWT({ id: user.id, role: user.role, name: user.name, email: user.email }, env.JWT_SECRET);
        return json({ token, role: user.role, name: user.name, id: user.id });
      }

      // ---- Admin: manage users (students/tutors) ----
      if (path === "/api/admin/users" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        const salt = crypto.randomUUID();
        const hash = await hashPassword(b.password, salt);
        const res = await env.DB.prepare(
          `INSERT INTO users (role, name, email, phone, momo_number, bank_name, bank_account, password_hash, password_salt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(b.role, b.name, b.email, b.phone || null, b.momo_number || null, b.bank_name || null, b.bank_account || null, hash, salt).run();
        return json({ id: res.meta.last_row_id });
      }

      if (path === "/api/admin/users" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, role, name, email, phone, momo_number, bank_name, bank_account FROM users WHERE role != 'admin' ORDER BY name"
        ).all();
        return json({ users: results });
      }

      // ---- Admin: payments ----
      if (path === "/api/admin/payments" && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const b = await request.json();
        const res = await env.DB.prepare(
          `INSERT INTO payments (recipient_id, recipient_type, amount, currency, method, status, note, created_by)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).bind(b.recipient_id, b.recipient_type, b.amount, b.currency || "UGX", b.method, b.note || null, auth.id).run();
        return json({ id: res.meta.last_row_id });
      }

      if (path === "/api/admin/payments" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          `SELECT p.*, u.name as recipient_name, u.momo_number, u.bank_name, u.bank_account
           FROM payments p JOIN users u ON u.id = p.recipient_id
           ORDER BY p.created_at DESC`
        ).all();
        return json({ payments: results });
      }

      // Trigger an actual payout for a pending record
      const payMatch = path.match(/^\/api\/admin\/payments\/(\d+)\/pay$/);
      if (payMatch && request.method === "POST") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const id = payMatch[1];
        const payment = await env.DB.prepare(
          `SELECT p.*, u.momo_number, u.bank_name, u.bank_account FROM payments p JOIN users u ON u.id = p.recipient_id WHERE p.id = ?`
        ).bind(id).first();
        if (!payment) return json({ error: "Payment not found" }, 404);

        if (payment.method === "momo") {
          if (!payment.momo_number) return json({ error: "Recipient has no MoMo number on file" }, 400);
          try {
            const result = await momoDisburse(env, {
              amount: payment.amount,
              currency: payment.currency,
              phone: payment.momo_number,
              externalId: `sce-${payment.id}`,
              note: payment.note || "Selfless CE payment",
            });
            await env.DB.prepare("UPDATE payments SET status = 'processing', reference = ? WHERE id = ?")
              .bind(result.referenceId, id).run();
            return json({ status: "processing", reference: result.referenceId });
          } catch (err) {
            await env.DB.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").bind(id).run();
            return json({ error: String(err) }, 502);
          }
        } else {
          // Bank transfers aren't automated — admin marks as paid after doing the transfer manually.
          const body = await request.json().catch(() => ({}));
          await env.DB.prepare("UPDATE payments SET status = 'paid', reference = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(body.reference || "manual-bank-transfer", id).run();
          return json({ status: "paid" });
        }
      }

      // Poll MoMo status and sync it into our DB
      const statusMatch = path.match(/^\/api\/admin\/payments\/(\d+)\/status$/);
      if (statusMatch && request.method === "GET") {
        const auth = await requireAuth(request, env, ["admin"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const id = statusMatch[1];
        const payment = await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
        if (!payment || !payment.reference) return json({ error: "No reference to check" }, 400);
        const momoStatus = await momoCheckStatus(env, payment.reference);
        const newStatus = momoStatus.status === "SUCCESSFUL" ? "paid" : momoStatus.status === "FAILED" ? "failed" : "processing";
        await env.DB.prepare(
          `UPDATE payments SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN CURRENT_TIMESTAMP ELSE paid_at END WHERE id = ?`
        ).bind(newStatus, newStatus, id).run();
        return json({ status: newStatus, raw: momoStatus });
      }

      // ---- Student / tutor: own profile + payments ----
      if (path === "/api/me" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        return json({ id: auth.id, name: auth.name, email: auth.email, role: auth.role });
      }

      if (path === "/api/me/payments" && request.method === "GET") {
        const auth = await requireAuth(request, env, ["student", "tutor"]);
        if (!auth) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, amount, currency, method, status, note, created_at, paid_at FROM payments WHERE recipient_id = ? ORDER BY created_at DESC"
        ).bind(auth.id).all();
        return json({ payments: results });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "Server error", detail: String(err) }, 500);
    }
  },
};
