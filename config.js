// Supabase project details. The anon / publishable key is designed to be public;
// access is controlled by the database rules in supabase/schema.sql.
window.PURGO_CONFIG = {
  url: 'https://iixqkqkmdholetujuqin.supabase.co',
  key: 'sb_publishable_zfndNRZtMBkaP85UDpX6Bg_dgHXXY5Y',
  googleMapsKey: ''   // browser key restricted to this site (Maps JavaScript API + Geocoding API)
};
// Test features (Measure) only appear on the dev site and on this computer
window.PURGO_DEV = /^dev\./.test(location.hostname) || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
if(window.PURGO_DEV) document.documentElement.classList.add('is-dev');
