const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const statuses = ["pending", "confirmed", "preparing", "ready", "fulfilled", "cancelled"];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function adminUser(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY")!, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user.app_metadata?.role === "admin" ? user : null;
}

async function db(path: string, init: RequestInit = {}) {
  return fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`, "Content-Type": "application/json", ...init.headers },
  });
}

async function sendOrderConfirmation(to: string, orderNumber: string, summary: string, subtotal: number) {
  const username = Deno.env.get("GMAIL_USER");
  const appPassword = Deno.env.get("GMAIL_APP_PASSWORD")?.replace(/\s/g, "");
  const sender = Deno.env.get("GMAIL_SENDER_EMAIL") ?? username;
  if (!username || !appPassword || !sender) throw new Error("Gmail is not configured");
  if (!emailPattern.test(username) || !emailPattern.test(sender) || !emailPattern.test(to)) throw new Error("Invalid email configuration");

  const subject = `Your Secret order ${orderNumber}`;
  const message = `Thank you for choosing Secret Flower Studio.\n\nOrder ${orderNumber}\n${summary}\nSubtotal: LKR ${subtotal.toLocaleString("en-LK")}\n\nWe’ll be in touch to arrange delivery.`;
  const encodedBody = btoa(Array.from(new TextEncoder().encode(message), byte => String.fromCharCode(byte)).join(""));
  const conn = await Deno.connectTls({ hostname: "smtp.gmail.com", port: 465 });
  let pending = "";
  const readBuffer = new Uint8Array(1024);
  const decoder = new TextDecoder();

  const readLine = async () => {
    while (!pending.includes("\n")) {
      const count = await conn.read(readBuffer);
      if (count === null) throw new Error("Gmail closed the SMTP connection");
      pending += decoder.decode(readBuffer.subarray(0, count), { stream: true });
    }
    const index = pending.indexOf("\n");
    const line = pending.slice(0, index).replace(/\r$/, "");
    pending = pending.slice(index + 1);
    return line;
  };

  const expect = async (accepted: number[]) => {
    let line: string;
    do {
      line = await readLine();
    } while (/^\d{3}-/.test(line));
    const code = Number(line.slice(0, 3));
    if (!accepted.includes(code)) throw new Error(`Gmail SMTP returned ${code}`);
  };

  const command = async (value: string, accepted: number[]) => {
    const bytes = new TextEncoder().encode(`${value}\r\n`);
    let offset = 0;
    while (offset < bytes.length) offset += await conn.write(bytes.subarray(offset));
    await expect(accepted);
  };

  try {
    await expect([220]);
    await command("EHLO localhost", [250]);
    await command("AUTH LOGIN", [334]);
    await command(btoa(username), [334]);
    await command(btoa(appPassword), [235]);
    await command(`MAIL FROM:<${sender}>`, [250]);
    await command(`RCPT TO:<${to}>`, [250, 251]);
    await command("DATA", [354]);
    const data = [
      `From: Secret Flower Studio <${sender}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      encodedBody,
      ".",
    ].join("\r\n") + "\r\n";
    const bytes = new TextEncoder().encode(data);
    let offset = 0;
    while (offset < bytes.length) offset += await conn.write(bytes.subarray(offset));
    await expect([250]);
    await command("QUIT", [221]);
  } finally {
    conn.close();
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    if (body.action === "create") {
      const c = body.customer ?? {};
      const recipientName = c.recipient_name ?? c.name;
      const recipientPhone = c.recipient_phone ?? c.phone;
      const valid = typeof c.name === "string" && c.name.trim().length > 0 && c.name.length <= 100 && typeof c.email === "string" && emailPattern.test(c.email.trim()) && c.email.length <= 254 && typeof c.phone === "string" && /^[+0-9() -]{7,20}$/.test(c.phone) && typeof recipientName === "string" && recipientName.trim().length > 0 && recipientName.length <= 100 && typeof recipientPhone === "string" && /^[+0-9() -]{7,20}$/.test(recipientPhone);
      if (!valid || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20 || !/^[0-9a-f-]{36}$/i.test(body.client_request_id ?? "")) return reply({ error: "Please check your contact, delivery, and order details." }, 400);
      const items = body.items.map((item: any) => ({
        flower_id: item.flower_id,
        stems: Number(item.stems),
        stemColors: Array.isArray(item.stemColors) ? item.stemColors : [],
        wrap: typeof item.wrap === "string" ? item.wrap.slice(0, 30) : "Oat",
        messages: Array.isArray(item.messages) ? item.messages : [],
        extraNoteCount: Number(item.extraNoteCount ?? 0),
      }));
      const allowedColors: Record<string, string[]> = { chrysanthemum: ["Pink", "Purple", "Red", "White", "Orange"], lilies: ["White", "Pink", "Orange"], rose: ["Red", "Pink", "White"] };
      if (items.some((item: any) => !["chrysanthemum", "lilies", "rose"].includes(item.flower_id) || !Number.isInteger(item.stems) || item.stems < 1 || item.stems > 4 || item.stemColors.length !== item.stems || item.stemColors.some((x: unknown) => !allowedColors[item.flower_id].includes(x as string)) || !Number.isInteger(item.extraNoteCount) || item.extraNoteCount < 0 || item.extraNoteCount > 10 || item.messages.length !== item.extraNoteCount && item.messages.length !== item.extraNoteCount + 1 || item.messages.some((x: unknown) => typeof x !== "string" || !x.trim() || x.length > 1600))) return reply({ error: "One of the flower selections or notes is invalid." }, 400);
      const created = await db("rpc/create_flower_order", { method: "POST", body: JSON.stringify({ p_order: { client_request_id: body.client_request_id, customer_name: c.name, customer_email: c.email, customer_phone: c.phone, recipient_name: recipientName, recipient_phone: recipientPhone, items } }) });
      const order = await created.json();
      if (!created.ok) return reply({ error: "We couldn’t save your order. Please try again." }, 400);
      // Email is attempted only after the atomic order transaction returns successfully.
      const emailConfigured = Boolean(Deno.env.get("GMAIL_USER") && Deno.env.get("GMAIL_APP_PASSWORD"));
      if (!order.existing && emailConfigured) {
        const summary = items.map((item: any) => `${item.stems} ${item.stems === 1 ? "stem" : "stems"} of ${item.flower_id}`).join(", ");
        try {
          await sendOrderConfirmation(c.email, order.order_number, summary, Number(order.subtotal));
          await db(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_email_status: "sent", confirmation_email_error: null }) });
          order.confirmation_email_status = "sent";
        } catch {
          await db(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_email_status: "failed", confirmation_email_error: "Provider send failed" }) });
          order.confirmation_email_status = "failed";
        }
      } else if (!emailConfigured) {
        order.confirmation_email_status = "not_configured";
      }
      return reply({ order }, 201);
    }

    const user = await adminUser(req);
    if (!user) return reply({ error: "Admin sign-in required." }, 401);
    if (body.action === "list") {
      const response = await db("orders?select=*&order=created_at.desc&limit=200");
      const orders = await response.json();
      if (!response.ok) return reply({ error: "Orders could not be loaded." }, 502);
      const ids = orders.map((o: any) => o.id);
      if (ids.length) {
        const [itemsRes, notesRes] = await Promise.all([db(`order_items?select=*&order_id=in.(${ids.join(",")})`), db(`order_notes?select=*&order_id=in.(${ids.join(",")})`) ]);
        const items = await itemsRes.json(); const notes = await notesRes.json();
        for (const order of orders) {
          order.items = items.filter((x: any) => x.order_id === order.id).map((item: any) => ({ ...item, notes: notes.filter((n: any) => n.order_item_id === item.id) }));
        }
      } else for (const order of orders) order.items = [];
      return reply({ orders });
    }
    if (body.action === "status") {
      if (typeof body.id !== "string" || !statuses.includes(body.status)) return reply({ error: "Invalid order status." }, 400);
      const response = await db(`orders?id=eq.${encodeURIComponent(body.id)}&select=id,order_number,status`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: body.status, updated_at: new Date().toISOString() }) });
      const rows = await response.json();
      if (!response.ok || !rows.length) return reply({ error: "Order status could not be updated." }, 400);
      return reply({ order: rows[0] });
    }
    if (body.action === "demand") {
      const from = new Date(body.from); const to = new Date(body.to);
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) return reply({ error: "Choose a valid date range." }, 400);
      const response = await db(`orders?select=id,created_at,status&created_at=gte.${encodeURIComponent(from.toISOString())}&created_at=lte.${encodeURIComponent(to.toISOString())}&status=neq.cancelled`);
      const orders = await response.json(); if (!response.ok) return reply({ error: "Demand could not be loaded." }, 502);
      const ids = orders.map((o: any) => o.id);
      if (!ids.length) return reply({ demand: { stems: { chrysanthemum: 0, lilies: 0, rose: 0 }, notes: { total: 0, included: 0, extra: 0 }, included_statuses: statuses.filter(s => s !== "cancelled") } });
      const [itemsRes, notesRes] = await Promise.all([db(`order_items?select=flower_id,stem_quantity,order_id&order_id=in.(${ids.join(",")})`), db(`order_notes?select=note_type,order_id&order_id=in.(${ids.join(",")})`)]);
      const items = await itemsRes.json(); const notes = await notesRes.json();
      const stems = { chrysanthemum: 0, lilies: 0, rose: 0 };
      for (const item of items) stems[item.flower_id as keyof typeof stems] += item.stem_quantity;
      const included = notes.filter((n: any) => n.note_type === "included").length; const extra = notes.filter((n: any) => n.note_type === "extra").length;
      return reply({ demand: { stems, notes: { total: included + extra, included, extra }, included_statuses: statuses.filter(s => s !== "cancelled") } });
    }
    if (body.action === "retry_email") {
      const r = await db(`orders?id=eq.${encodeURIComponent(body.id)}&select=*`); const rows = await r.json(); const order = rows[0];
      if (!order) return reply({ error: "Order not found." }, 404);
      if (!Deno.env.get("GMAIL_USER") || !Deno.env.get("GMAIL_APP_PASSWORD")) return reply({ error: "Confirmation email is not configured." }, 503);
      const ir = await db(`order_items?select=flower_name,stem_quantity&order_id=eq.${order.id}`); const items = await ir.json();
      const summary = items.map((x: any) => `${x.stem_quantity} ${x.stem_quantity === 1 ? "stem" : "stems"} of ${x.flower_name}`).join(", ");
      try {
        await sendOrderConfirmation(order.customer_email, order.order_number, summary, Number(order.subtotal));
      } catch {
        return reply({ error: "Email retry failed. The saved order is unchanged." }, 502);
      }
      await db(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_email_status: "sent", confirmation_email_error: null }) });
      return reply({ ok: true });
    }
    return reply({ error: "Unknown action." }, 400);
  } catch {
    return reply({ error: "The request could not be completed." }, 500);
  }
});
