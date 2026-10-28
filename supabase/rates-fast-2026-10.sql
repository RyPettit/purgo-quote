-- Purgō: faster (high-end) production rates for our kit.
-- Only these timings change; prices and anything else you have set in Admin stay as they are.
update public.settings
set value = value || '{"sf_block":55,"sf_concrete":70,"sf_tarmac":55,"sf_stone":40,"sf_imprint":60,"sf_porcelain":65,"sf_deck":35,"pwSetupTime":0.33,"sandRate":80,"chemApp":200,"gutSpeed":40,"gutSpeed3":28,"fasSpeed":25,"winMins":1.5,"winSetup":8,"scrapeRate":12,"lpwRate":25,"towerErect":0.75,"towerDismantle":0.5}'::jsonb, updated_at = now()
where key = 'rates';

select key, value->>'sf_block' as block_m2_hr, value->>'sandRate' as sand_m2_hr, value->>'gutSpeed' as gutter_m_hr, value->>'winMins' as mins_per_window
from public.settings where key = 'rates';
