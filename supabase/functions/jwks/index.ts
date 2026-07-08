// jwks/index.ts — JWKS + OIDC Discovery pour Workload Identity Federation
const ISSUER = "https://jxrwgcsbomqvvchvkkdt.supabase.co/functions/v1/jwks";

const JWKS = {
  keys: [{
    kty: "RSA", use: "sig", alg: "RS256", kid: "editbot-wif-key-1",
    key_ops: ["verify"],
    n: "wofqnJJvHEhvDWrAIszHgWTVTh6nmAds2Y_b-Xawpse22ZIqY92RThSdba-CD7a9gqnmZMqYeWVTXg0xTZkDFQ8aCcjB3vtUFICoHi1Y5gQax9t7tF8g_DAJD6YEXDEue-L9q1BiX9Ngq-8vn1WsNcfPFEedRPSFwuP2WFTzxuGEb12ZZg1omNiaGw3SCK-2UnBBefMhkkmnr5XwaZXwkF9OXc4mpCQfodyfYtgjdmqTHFH7IxqINQZ0mtpgWMZb28LuPrXmeZIoeaqBUBnnRytzruywtAjrzx7oLfPGAHndc5jy1CXE62jk78ofKvnkc-uy3vVTv_cRBDs5n7MdUQ",
    e: "AQAB",
  }],
};

const OIDC_DISCOVERY = {
  issuer: ISSUER,
  jwks_uri: ISSUER,
  response_types_supported: ["id_token"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });

Deno.serve((req: Request) => {
  const url = new URL(req.url);
  // Google STS fetch: {issuer}/.well-known/openid-configuration
  if (url.pathname.endsWith("/.well-known/openid-configuration")) {
    return json(OIDC_DISCOVERY);
  }
  // Default : retourner le JWKS
  return json(JWKS);
});
