// Plays an Aircall recording on the board. Aircall's recording links expire
// after a few minutes, so the board asks for a fresh one each time someone
// presses play:
//
//   POST /functions/v1/call-recording
//   { "person_id", "passcode", "flag_id", "aircall_id" }  ->  { "url" }
//
// The person's own passcode is checked, and the call must belong to a flag
// they can see (a rep: only their own orders). The Aircall key never leaves
// this function.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { person_id, passcode, flag_id, aircall_id } = await req.json();
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const check = await fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/rpc/_commission_call_access", {
      method: "POST",
      headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: "Bearer " + key } : {}), "Content-Type": "application/json" },
      body: JSON.stringify({ p_person_id: person_id, p_passcode: passcode, p_flag_id: flag_id, p_aircall_id: Number(aircall_id) }),
    });
    if (!check.ok) return json({ error: "wrong name or passcode" }, 403);
    if ((await check.json()) !== true) return json({ error: "not your call" }, 403);

    const id = Deno.env.get("AIRCALL_API_ID"), token = Deno.env.get("AIRCALL_API_TOKEN");
    if (!id || !token) return json({ error: "Aircall isn't connected yet" }, 503);
    const res = await fetch(`https://api.aircall.io/v1/calls/${Number(aircall_id)}`, {
      headers: { Authorization: "Basic " + btoa(`${id}:${token}`) },
    });
    if (!res.ok) return json({ error: `Aircall: ${res.status}` }, 502);
    const call = (await res.json()).call || {};
    if (!call.recording) return json({ error: "no recording for this call" }, 404);
    return json({ url: call.recording, aircall_url: call.asset || null });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 500);
  }
});
