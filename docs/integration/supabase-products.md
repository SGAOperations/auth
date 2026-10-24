# Supabase-backed products

Integration guide for products that use Supabase and trust SGAuth as a third-party auth provider. AUTH-T81 (#93) completes this guide; for now it holds only the token requirements checklist.

## Token requirements

Each requirement is proved by a test in [`src/lib/auth/jwt-conformance.db.test.ts`](../../src/lib/auth/jwt-conformance.db.test.ts). The test title is given in quotes.

- [ ] ES256 signature, with a `kid` in the header that is published in the JWKS: "verifies through the remote JWKS, with an ES256 header that names a published kid".
- [ ] `role` is `authenticated`: "carries the claims Supabase reads".
- [ ] `sub` is the user's UUID: "carries the claims Supabase reads".
- [ ] `iss` equals the discovery document's `issuer`: "carries the claims Supabase reads".
- [ ] `aud` is `authenticated`: "carries the claims Supabase reads".
- [ ] Lifetime (`exp - iat`) is at most 10 minutes: "carries the claims Supabase reads".
- [ ] The discovery document is valid, and `jwks_uri` resolves to a key set: "names an issuer that is a bare origin, a jwks_uri under it, and ES256", "is served at the well-known path, and the key set at jwks.json", "points jwks_uri at a key set that answers with keys".
- [ ] The JWKS holds public keys only: "publishes public ES256 P-256 keys only, each with a unique kid".
- [ ] A rotated-out key stays published for 7 days, then is dropped: "keeps the retired key published for 7 days, then drops it".
- [ ] The token endpoint requires a live session: "refuses a request with no cookie", "refuses a cookie with a tampered signature", "refuses a session that was revoked", "refuses a session that has expired".
