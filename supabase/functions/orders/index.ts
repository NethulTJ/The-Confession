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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    if (body.action === "create") {
      const c = body.customer ?? {};
      const valid = typeof c.name === "string" && c.name.trim().length > 0 && c.name.length <= 100 && typeof c.email === "string" && emailPattern.test(c.email.trim()) && c.email.length <= 254 && typeof c.phone === "string" && /^[+0-9() -]{7,20}$/.test(c.phone) && typeof c.address === "string" && c.address.trim().length > 0 && c.address.length <= 300 && typeof c.city === "string" && c.city.trim().length > 0 && c.city.length <= 100 && (!c.postal_code || typeof c.postal_code === "string" && c.postal_code.length <= 20) && (!c.instructions || typeof c.instructions === "string" && c.instructions.length <= 500);
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
      const created = await db("rpc/create_flower_order", { method: "POST", body: JSON.stringify({ p_order: { client_request_id: body.client_request_id, customer_name: c.name, customer_email: c.email, customer_phone: c.phone, delivery_address: c.address, delivery_city: c.city, delivery_postal_code: c.postal_code ?? "", delivery_instructions: c.instructions ?? "", items } }) });
      const order = await created.json();
      if (!created.ok) return reply({ error: "We couldn’t save your order. Please try again." }, 400);
      // Email is attempted only after the atomic order transaction returns successfully.
      const emailKey = Deno.env.get("RESEND_API_KEY");
      const from = Deno.env.get("ORDER_EMAIL_FROM");
      if (!order.existing && emailKey && from) {
        const summary = items.map((item: any) => `${item.stems} ${item.stems === 1 ? "stem" : "stems"} of ${item.flower_id}`).join(", ");
        try {
          const sent = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${emailKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [c.email], subject: `Your Secret order ${order.order_number}`, text: `Thank you for choosing Secret Flower Studio.\n\nOrder ${order.order_number}\n${summary}\nSubtotal: LKR ${order.subtotal.toLocaleString("en-LK")}\n\nWe’ll be in touch to arrange delivery.` }) });
          if (!sent.ok) throw new Error(`Email provider returned ${sent.status}`);
          await db(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_email_status: "sent", confirmation_email_error: null }) });
          order.confirmation_email_status = "sent";
        } catch {
          await db(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_email_status: "failed", confirmation_email_error: "Provider send failed" }) });
          order.confirmation_email_status = "failed";
        }
      } else if (!emailKey || !from) {
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
      const emailKey = Deno.env.get("RESEND_API_KEY"); const from = Deno.env.get("ORDER_EMAIL_FROM");
      if (!emailKey || !from) return reply({ error: "Confirmation email is not configured." }, 503);
      const ir = await db(`order_items?select=flower_name,stem_quantity&order_id=eq.${order.id}`); const items = await ir.json();
      const summary = items.map((x: any) => `${x.stem_quantity} ${x.stem_quantity === 1 ? "stem" : "stems"} of ${x.flower_name}`).join(", ");
      const sent = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${emailKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [order.customer_email], subject: `Your Secret order ${order.order_number}`, text: `Thank you for choosing Secret Flower Studio.\n\nOrder ${order.order_number}\n${summary}\nSubtotal: LKR ${Number(order.subtotal).toLocaleString("en-LK")}\n\nWe’ll be in touch to arrange delivery.` }) });
      if (!sent.ok) return reply({ error: "Email retry failed. The saved order is unchanged." }, 502);
      await db(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_email_status: "sent", confirmation_email_error: null }) });
      return reply({ ok: true });
    }
    return reply({ error: "Unknown action." }, 400);
  } catch {
    return reply({ error: "The request could not be completed." }, 500);
  }
});
