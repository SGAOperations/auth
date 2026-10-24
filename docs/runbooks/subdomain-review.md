# Subdomain review

Inventory every DNS record under `northeasternsga.com` and remove dangling ones, per [SUBDOMAIN-POLICY.md](../SUBDOMAIN-POLICY.md). Used for the first review and every quarter. Commands work in PowerShell and bash: on Windows use `curl.exe`, elsewhere `curl`.

1. **Export the zone** from the DNS host: every record type. Record the provider and the export date in the inventory header.
2. **Cross-check Certificate Transparency.** Search `https://crt.sh/?q=%25.northeasternsga.com`. Any hostname with a certificate in the last 12 months that is missing from the export means another DNS host or a delegated subzone: find it before going on.
3. **Fill the inventory**, one row per record, with every column from [the policy](../SUBDOMAIN-POLICY.md#inventory).
4. **Test each record for dangling**, by type:
   - **Vercel** (CNAME `cname.vercel-dns.com` or `*.vercel-dns-*.com`, A `76.76.21.21`):
     - `curl -sSI https://<host>`. A `404` with `x-vercel-error: DEPLOYMENT_NOT_FOUND` means no project serves the name, so it is dangling.
     - In any case, confirm in the SGA Vercel team's Domains page that a project in **that team** holds the name.
   - **Other CNAME:** `nslookup -type=CNAME <host>`, then resolve the target.
     - An NXDOMAIN target is dangling.
     - So is a provider "no such app/site/bucket" page. The fingerprints are listed in `https://github.com/EdOverflow/can-i-take-over-xyz`.
   - **A/AAAA:** the IP belongs to a resource in an SGA account (check the provider console). A released cloud IP can be reassigned to anyone.
   - **NS delegation:** `nslookup -type=SOA <sub> <each nameserver>`. `REFUSED`, `SERVFAIL` or no answer means dangling.
   - **MX/TXT:** the service is still in use by SGA. Remove stale verification TXT records too: hygiene, not takeover.
   - **HTTPS (R7):** `curl -sSI http://<host>` returns `301` or `308` to `https://`.
5. **Remediate:**
   - dangling: delete the record now (R6), then release whatever is left of the target;
   - wildcard: delete;
   - other breaches: fix, or log an exception.
6. **Reconcile the registry.** Once #68 has rows:
   - run `SELECT slug, "baseUrl", "isActive" FROM "Product" ORDER BY slug;` read-only in the Neon SQL editor, on `main` and on `dev`;
   - every active `baseUrl` host has a record;
   - every product-class record maps to an active row;
   - inactive products have none.

   Until the registry has rows, skip this step. R1's product hosts come from the rollout order, and each is an exception until it is registered.

7. **Record.** Comment on the review issue with:
   - the inventory link;
   - counts: records, dangling found and removed, exceptions, non-HTTPS hosts;
   - exceptions past their target date.

   Then close the issue.
