// TfL Unified API configuration.
//
// The site works WITHOUT a key, but TfL rate-limits unauthenticated traffic.
// To raise the limit, register a free key at https://api-portal.tfl.gov.uk
// and paste it below. Since this is a public static site, prefer a
// DOMAIN-LOCKED key (set the allowed origin in the TfL portal) so it can be
// safely committed.
window.TFL_CONFIG = {
  appKey: "", // <-- paste your TfL primary key here (optional)
};
