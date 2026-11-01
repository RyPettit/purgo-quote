// Which database the app uses is decided by the web address, so the dev site can never touch live data.
// Live: quote.purgo-clean.com and purgo-quote.pages.dev. Everything else (dev.purgo-quote.pages.dev,
// preview links, this computer) uses the separate dev database.
// The anon / publishable keys are designed to be public; access is controlled by the database rules.
(function(){
  const LIVE_HOSTS = ['quote.purgo-clean.com', 'purgo-quote.pages.dev'];
  const live = LIVE_HOSTS.includes(location.hostname);
  window.PURGO_DEV = !live;
  window.PURGO_CONFIG = live ? {
    env: 'live',
    url: 'https://iixqkqkmdholetujuqin.supabase.co',
    key: 'sb_publishable_zfndNRZtMBkaP85UDpX6Bg_dgHXXY5Y'
    // no measuring on live: the AI and map keys live only in the dev project
  } : {
    env: 'dev',
    url: 'https://mzqgazqbkmenssrdbuiq.supabase.co',
    key: 'sb_publishable_X2BGXBPYkz_egZQXnztvrA_qs6sBM26',
    googleMapsKey: 'AIzaSyA8dEa4D-beDLkn3oM0Yg1w-DaFRKkFrrk',   // browser key restricted to the Purgō sites
    measureFunction: 'measure'
  };
  if(window.PURGO_DEV) document.documentElement.classList.add('is-dev');
})();
