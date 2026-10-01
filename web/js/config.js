// This app's own Supabase project (see SETUP.md).
// The publishable (anon) key is meant to be public -- it's safe to commit and ship to the
// browser. It grants nothing by itself: commission data is only reachable
// through the passcode-checked functions in
// supabase/migrations/0001_commission_review.sql.
window.SUPABASE_CONFIG = {
  url: "https://wumotelrvysafszdxldw.supabase.co",
  anonKey: "sb_publishable_zJhzqK3fHnTIryhXCDNtqQ_jVAj-AoD",
};
