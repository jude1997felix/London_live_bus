// Template for TfL Unified API configuration.
//
// 1. Copy this file to `config.js`  (cp config.example.js config.js)
// 2. Paste your free key from https://api-portal.tfl.gov.uk
//
// `config.js` is git-ignored, so your key stays out of the public repo.
// The site still works without a key (TfL just rate-limits harder), so the
// deployed GitHub Pages version runs keyless by design.
window.TFL_CONFIG = {
  appKey: "", // <-- paste your TfL primary key here
};
