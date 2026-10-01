// Aircall: the calls with a flagged order's customer, and their
// transcripts where Aircall has them (the Aircall AI add-on). Read only.
import { type CallRecord, localDate } from "./logic.ts";

const BASE = "https://api.aircall.io/v1";
// Aircall allows 60 requests a minute per company.
const GAP_MS = 1050;

export type AircallCreds = { id: string; token: string };
// One request at a time, GAP_MS apart, even with several orders in flight.
let gate: Promise<void> = Promise.resolve();
function nextSlot(): Promise<void> {
  const slot = gate.then(() => new Promise<void>((r) => setTimeout(r, GAP_MS)));
  const mine = gate;
  gate = slot;
  return mine;
}

async function aircall(creds: AircallCreds, path: string): Promise<any | null> {
  for (let attempt = 0; ; attempt++) {
    await nextSlot();
    const res = await fetch(BASE + path, { headers: { Authorization: "Basic " + btoa(`${creds.id}:${creds.token}`) } });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    if (res.status === 404 || res.status === 403) return null; // e.g. no transcript / no AI add-on
    if (!res.ok) throw new Error(`Aircall ${path.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

type AircallCall = {
  id: number; direction: string; status: string; started_at: number; answered_at: number | null; duration: number;
  raw_digits: string; user: { name: string } | null; recording: string | null; asset: string | null;
};

// Calls with any of these numbers from 30 days before the order to 14 after.
export async function callsForOrder(
  creds: AircallCreds, phones: string[], orderIso: string, timeZone: string, opts: { transcripts: boolean },
): Promise<CallRecord[]> {
  const at = Math.floor(new Date(orderIso).getTime() / 1000);
  const from = at - 30 * 86400, to = at + 14 * 86400;
  const byId = new Map<number, AircallCall>();
  for (const phone of phones) {
    const q = new URLSearchParams({ phone_number: phone, from: String(from), to: String(to), per_page: "50", order: "asc" });
    const data = await aircall(creds, `/calls/search?${q}`);
    for (const c of (data?.calls || []) as AircallCall[]) byId.set(c.id, c);
  }
  const calls = [...byId.values()].sort((a, b) => a.started_at - b.started_at).slice(0, 12);
  const out: CallRecord[] = [];
  let transcribed = 0;
  for (const c of calls) {
    const startedIso = new Date(c.started_at * 1000).toISOString();
    const record: CallRecord = {
      id: `aircall-${c.id}`, aircall_id: c.id, source: "Aircall", date: localDate(startedIso, timeZone), started_at: startedIso,
      rep: c.user?.name || null, minutes: Math.max(1, Math.round((c.duration || 0) / 60)), direction: c.direction,
      answered: !!c.answered_at, has_recording: !!(c.recording || c.asset), lines: [],
    };
    // Transcripts only for real conversations, a few per order.
    if (opts.transcripts && record.answered && c.duration >= 30 && transcribed < 4) {
      const t = await aircall(creds, `/calls/${c.id}/transcription`);
      const utterances = t?.transcription?.content?.utterances || [];
      if (utterances.length) transcribed++;
      record.lines = utterances.map((u: any) => {
        const isRep = u.participant_type === "internal";
        return {
          speaker: isRep ? "rep" : "customer",
          name: isRep ? (record.rep || "Rep").split(" ")[0] : "Customer",
          t: Math.round(Number(u.start_time) || 0),
          text: String(u.text || "").trim(),
        };
      }).filter((l: { text: string }) => l.text);
    }
    out.push(record);
  }
  return out;
}
