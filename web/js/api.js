// Thin wrapper over Supabase's REST API (PostgREST). Every call goes
// through a function in supabase/migrations/0001_commission_review.sql,
// which re-checks the person's own passcode server-side -- commission data
// is never readable with a plain table read.
const API = (() => {
  const cfg = window.SUPABASE_CONFIG || {};
  const BASE = (cfg.url || "").replace(/\/$/, "");
  const KEY = cfg.anonKey || "";
  // Legacy anon keys are JWTs and go in Authorization too; the newer
  // sb_publishable_... keys only go in the apikey header (Supabase rejects
  // them as a Bearer token on some endpoints, e.g. Storage).
  const AUTH = KEY.startsWith("eyJ") ? { Authorization: "Bearer " + KEY } : {};

  async function rest(path, opts = {}) {
    const res = await fetch(BASE + "/rest/v1/" + path, {
      ...opts,
      headers: {
        apikey: KEY,
        ...AUTH,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        message = body.message || body.error_description || message;
      } catch (e) {}
      throw new Error(message);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function rpc(fn, args) {
    return rest("rpc/" + fn, { method: "POST", body: JSON.stringify(args) });
  }

  // Uploads straight to Supabase Storage and returns the public URL.
  // Files get a 128-bit random name: the proof bucket has no listing
  // policy, so the URL itself is what keeps a screenshot private.
  async function uploadPublicFile(bucket, file) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    const path = rand + "." + ext;
    const res = await fetch(BASE + "/storage/v1/object/" + bucket + "/" + path, {
      method: "POST",
      headers: {
        apikey: KEY,
        ...AUTH,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        message = body.message || body.error || message;
      } catch (e) {}
      throw new Error(message);
    }
    return BASE + "/storage/v1/object/public/" + bucket + "/" + path;
  }

  return {
    configured() {
      return !!(BASE && KEY) && !BASE.includes("YOUR-PROJECT-REF") && !KEY.includes("YOUR-ANON-KEY");
    },

    listCommissionPeople() { return rpc("list_commission_people", {}); },
    commissionLogin(personId, passcode) {
      return rpc("commission_login", { p_person_id: personId, p_passcode: passcode }).then((rows) => rows[0]);
    },
    commissionBoard(personId, passcode, period) {
      return rpc("commission_board", { p_person_id: personId, p_passcode: passcode, p_period: period || null });
    },
    commissionAnswer(personId, passcode, flagId, reason, caseText, proof) {
      return rpc("commission_answer", { p_person_id: personId, p_passcode: passcode, p_flag_id: flagId, p_reason: reason, p_case: caseText, p_proof: proof || [] });
    },
    commissionDecide(personId, passcode, flagId, decision, waived, note) {
      return rpc("commission_decide", { p_person_id: personId, p_passcode: passcode, p_flag_id: flagId, p_decision: decision, p_waived: waived, p_note: note || null });
    },
    commissionAsk(personId, passcode, flagId, question) {
      return rpc("commission_ask", { p_person_id: personId, p_passcode: passcode, p_flag_id: flagId, p_question: question });
    },
    commissionEscalate(personId, passcode, flagId, note) {
      return rpc("commission_escalate", { p_person_id: personId, p_passcode: passcode, p_flag_id: flagId, p_note: note || null });
    },
    commissionImport(personId, passcode, rows) {
      return rpc("commission_import", { p_person_id: personId, p_passcode: passcode, p_rows: rows });
    },
    commissionSignOffWeek(personId, passcode, period, week) {
      return rpc("commission_sign_off_week", { p_person_id: personId, p_passcode: passcode, p_period: period, p_week: week });
    },
    commissionWeeklyPing(personId, passcode, send) {
      return rpc("commission_post_weekly_ping", { p_person_id: personId, p_passcode: passcode, p_send: !!send });
    },
    uploadCommissionProof(file) {
      return uploadPublicFile("commission-proof", file);
    },
  };
})();
