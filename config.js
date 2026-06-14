// TfL Unified API configuration.
//
// The site works WITHOUT a key, but TfL rate-limits unauthenticated traffic.
// To raise the limit, register a free key at https://api-portal.tfl.gov.uk
// and paste it below. Since this is a public static site, prefer a
// DOMAIN-LOCKED key (set the allowed origin in the TfL portal) so it can be
// safely committed.
window.TFL_CONFIG = {
  appKey: "ed992073c4134e718b6339b57fc4b784", // <-- your TfL primary key
};
