// True when the client actually prefers HTML.
//
// req.accepts("html") is the trap: it returns "html" for Accept: */* - the
// default curl and fetch send - and for a missing Accept header, so every JSON
// API client was served an HTML fragment with the wrong status code. Listing
// json first makes it win the wildcard tie-break, because express resolves a
// tie at equal quality in favour of whichever type the server named first.
function wantsHtml(req) {
  return req.accepts(["json", "html"]) === "html";
}

module.exports = { wantsHtml };
