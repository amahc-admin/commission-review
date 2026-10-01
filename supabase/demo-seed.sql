-- OPTIONAL demo data for the Commission review board -- the September
-- orders from the walkthrough deck, so the board isn't empty the first
-- time someone opens it. Run AFTER migrations/0018_commission_review.sql.
-- Safe to re-run (upserts by order + kind). Delete it all again with:
--   delete from commission_flags where period = '2026-09';
--
-- Real flags come in through commission_import (see SETUP.md).

insert into commission_flags (id, order_no, kind, period, order_date, customer, rep_id, gross, amount, pct, order_url, details, slices, ai, calls) values
(
  'discount-23544', '23544', 'discount', '2026-09', '2026-09-01', 'Karan Singh', 'beshoy', 3027, 509, 16.8, null, '{}',
  '[{"type":"free item","label":"100% off — Premium Pool Table Accessory Kit","note":"no campaign registered 1 Sep","amount":300,"side":"rep"},
    {"type":"named manual","label":"Pre order and save","note":"no matching promo that day","amount":91,"side":"rep"},
    {"type":"rep custom","label":"Custom discount","note":"unnamed, rep-keyed","amount":91,"side":"rep"},
    {"type":"code","label":"B33RMONEY","note":"live site code — company''s","amount":27,"side":"company"}]',
  '{"verdict":"partial","waive_amount":27,"confidence":80,"discussed_on_call":true,"reviewed_at":"2026-10-01T02:00:00Z",
    "summary":"Only the B33RMONEY code was live on the site that day; the rest is the rep''s own call.",
    "points":["Code B33RMONEY was live in the site''s discount configs on 1 Sep, so its $27 slice is company-side. Waived.",
              "The $300 kit giveaway has no campaign or site promo behind it that day, and on the call the rep personally promises the accessories. Counts.",
              "No campaign named Pre order and save was registered or live on 1 Sep. Counts — register the campaign if this promo was real.",
              "The unnamed $91 custom discount is the rep''s own call. Counts."],
    "quotes":[{"speaker":"rep","text":"you''re getting the premium pool accessory kit for free.","call_id":"c-23544","t":95},
              {"speaker":"customer","text":"I recently saw, that $700 value of extras and accessories.","call_id":"c-23544","t":112}]}',
  '[{"id":"c-23544","source":"Phone","date":"2026-09-01","rep":"Beshoy Mikhail","minutes":6,"direction":"inbound","audio_url":null,
     "lines":[{"speaker":"rep","name":"Beshoy","t":80,"text":"So with the table today, mate, I can look after you."},
              {"speaker":"rep","name":"Beshoy","t":95,"text":"You''re getting the premium pool accessory kit for free."},
              {"speaker":"customer","name":"Customer","t":112,"text":"I recently saw, that $700 value of extras and accessories."},
              {"speaker":"rep","name":"Beshoy","t":130,"text":"Yep, that''s the one, all thrown in."}]}]'
),
(
  'discount-23549', '23549', 'discount', '2026-09', '2026-09-01', 'Bevan Clancy', 'beshoy', 4867, 482, 9.9, null, '{}',
  '[{"type":"promo","label":"Spring sale — 10% off tables","note":"live on site 1 Sep","amount":482,"side":"company"}]',
  '{"verdict":"waive","waive_amount":482,"confidence":94,"discussed_on_call":false,"reviewed_at":"2026-10-01T02:00:00Z",
    "summary":"The whole discount is the site-wide spring sale that was live that day.",
    "points":["Spring sale (10% off tables) was live on the site on 1 Sep and matches the discount exactly. Company-side. Waived."],
    "quotes":[]}', '[]'
),
(
  'discount-23655', '23655', 'discount', '2026-09', '2026-09-07', 'Prudence Geard', 'beshoy', 3167, 475, 15.0, null, '{}',
  '[{"type":"rep custom","label":"Custom discount","note":"unnamed, rep-keyed","amount":475,"side":"rep"}]',
  '{"verdict":"counts","waive_amount":0,"confidence":72,"discussed_on_call":false,"reviewed_at":"2026-10-01T02:00:00Z",
    "summary":"A rep-keyed custom discount with no promo, code or sign-off behind it.",
    "points":["No promo or code was live that matches. No call found where it was discussed. Counts unless the rep states a case."],
    "quotes":[]}', '[]'
),
(
  'discount-23759', '23759', 'discount', '2026-09', '2026-09-05', null, 'beshoy', 3142, 927, 29.5, null, '{}',
  '[{"type":"rep custom","label":"Custom discount","note":"unnamed, rep-keyed","amount":927,"side":"rep"}]',
  '{"verdict":"counts","waive_amount":0,"confidence":65,"discussed_on_call":false,"reviewed_at":"2026-10-01T02:00:00Z",
    "summary":"29.5% off with nothing on the site and no recording to explain it.",
    "points":["No recording or transcript found for this customer. The AI can''t see why — it says so rather than guessing. Counts unless the rep states a case."],
    "quotes":[]}', '[]'
),
(
  'discount-23763', '23763', 'discount', '2026-09', '2026-09-03', null, 'lachy', 3285, 3285, 100, null, '{}',
  '[{"type":"rep custom","label":"100% off order","note":"unnamed, rep-keyed","amount":3285,"side":"rep"}]',
  '{"verdict":"counts","waive_amount":0,"confidence":55,"discussed_on_call":false,"reviewed_at":"2026-10-01T02:00:00Z",
    "summary":"A full 100% discount -- usually a warranty replacement or an approved giveaway, but nothing attached says which.",
    "points":["Nothing on the site explains a 100% discount. If this was a replacement or a sign-off from Jaya or Ross, attach the screenshot."],
    "quotes":[]}', '[]'
),
(
  'freight-23571', '23571', 'freight', '2026-09', '2026-09-02', 'Mick Doherty', 'lachy', 5120, 260, null, null,
  '{"service":"Home delivery, 2-person","charged":90,"cost":350}', '[]',
  '{"verdict":"counts","waive_amount":0,"confidence":70,"discussed_on_call":true,"reviewed_at":"2026-10-01T02:00:00Z",
    "summary":"Freight charged $90 against a $350 Shopify rate for the service taken.",
    "points":["Charged $90; Shopify''s rate for 2-person home delivery to this postcode was $350. If this went on an Osama run, attach the booking screenshot."],
    "quotes":[{"speaker":"rep","text":"I''ll sort the delivery for ninety, don''t worry about it.","call_id":"c-23571","t":204}]}',
  '[{"id":"c-23571","source":"Phone","date":"2026-09-02","rep":"Lachy","minutes":9,"direction":"outbound","audio_url":null,
     "lines":[{"speaker":"customer","name":"Customer","t":190,"text":"What''s delivery going to be out to us?"},
              {"speaker":"rep","name":"Lachy","t":204,"text":"I''ll sort the delivery for ninety, don''t worry about it."}]}]'
),
(
  'freight-23590', '23590', 'freight', '2026-09', '2026-09-04', 'Sam Petrakis', 'lachy', 2890, -40, null, null,
  '{"service":"Depot pickup","charged":120,"cost":80}', '[]',
  '{"verdict":"for_rep","confidence":99,"reviewed_at":"2026-10-01T02:00:00Z",
    "summary":"Over-recovered: charged $40 more than the freight cost. Counts FOR the rep.","points":[],"quotes":[]}', '[]'
),
(
  'claim-23661', '23661', 'claim', '2026-09', '2026-09-07', 'Jason Ewart', 'beshoy', 866, 866, null, null,
  '{"claimed_by":"Beshoy","item":"Carlton Dry pool table lamp"}', '[]',
  '{"verdict":"unrelated","confidence":93,"reviewed_at":"2026-10-01T02:00:00Z",
    "summary":"The order is a Carlton Dry pool table lamp placed 7 Sep. On the claiming rep''s only call, same day, the customer says he had already ordered it — the call was about a replacement approved for a damaged earlier unit. All other calls are damage and delivery support handled by other reps.",
    "points":[],
    "quotes":[{"speaker":"customer","text":"No. I''ve already ordered one. I just got confirmation that it''s been approved for it to get delivered again.","call_id":"c-23661","t":19}]}',
  '[{"id":"c-23661","source":"Phone","date":"2026-09-07","rep":"Beshoy Mikhail","minutes":4,"direction":"inbound","audio_url":null,
     "lines":[{"speaker":"rep","name":"Beshoy","t":12,"text":"I believe you sent us an inquiry for a pool table. Am I right?"},
              {"speaker":"customer","name":"Customer","t":19,"text":"No. I''ve already ordered one. I just got confirmation that it''s been approved for it to get delivered again."},
              {"speaker":"customer","name":"Customer","t":41,"text":"Yeah. The other one that got delivered got damaged."},
              {"speaker":"rep","name":"Beshoy","t":62,"text":"That''s already been approved, and that''s already on for you."},
              {"speaker":"rep","name":"Beshoy","t":220,"text":"If you ever need anything, you''ve ordered from us five times before, mate. Give us a call."}]}]'
),
(
  'refund-23702', '23702', 'refund', '2026-09', '2026-09-16', 'Dale Ruston', 'lachy', 1450, 220, null, null,
  '{"reason":"Partial refund — scratched cue rack"}', '[]', '{}', '[]'
)
on conflict (order_no, kind) do update set
  period = excluded.period, order_date = excluded.order_date, customer = excluded.customer, rep_id = excluded.rep_id,
  gross = excluded.gross, amount = excluded.amount, pct = excluded.pct, details = excluded.details,
  slices = excluded.slices, ai = excluded.ai, calls = excluded.calls, updated_at = now();
