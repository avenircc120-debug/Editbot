// jwks/index.ts — Endpoint JWKS public pour Workload Identity Federation
// GET /functions/v1/jwks  (public, verify_jwt = false)
// Google Cloud WIF OIDC Provider pointe sur cette URL pour valider les JWTs
// générés par wif-auth.ts dans les autres Edge Functions.

const JWKS = {
  keys: [
    {
      kty: "RSA",
      use: "sig",
      alg: "RS256",
      kid: "editbot-wif-key-1",
      key_ops: ["verify"],
      n: "wofqnJJvHEhvDWrAIszHgWTVTh6nmAds2Y_b-Xawpse22ZIqY92RThSdba-CD7a9gqnmZMqYeWVTXg0xTZkDFQ8aCcjB3vtUFICoHi1Y5gQax9t7tF8g_DAJD6YEXDEue-L9q1BiX9Ngq-8vn1WsNcfPFEedRPSFwuP2WFTzxuGEb12ZZg1omNiaGw3SCK-2UnBBefMhkkmnr5XwaZXwkF9OXc4mpCQfodyfYtgjdmqTHFH7IxqINQZ0mtpgWMZb28LuPrXmeZIoeaqBUBnnRytzruywtAjrzx7oLfPGAHndc5jy1CXE62jk78ofKvnkc-uy3vVTv_cRBDs5n7MdUQ",
      e: "AQAB",
    },
  ],
};

Deno.serve((_req) =>
  new Response(JSON.stringify(JWKS), {
    headers: {
      "Content-Type":                "application/json",
      "Cache-Control":               "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  })
);
