Follow `docs/runbooks/subdomain-review.md`. Keep this list and that runbook in step.

- [ ] 1. Export the zone from the DNS host and record the provider and date.
- [ ] 2. Cross-check Certificate Transparency (crt.sh) for hostnames missing from the export.
- [ ] 3. Fill the inventory, one row per record, with every policy column.
- [ ] 4. Test each record for dangling, by type, and check HTTPS redirects.
- [ ] 5. Remediate: delete dangling and wildcard records, fix or log exceptions.
- [ ] 6. Reconcile the inventory with the product registry.
- [ ] 7. Comment the inventory link and counts, then close this issue.
