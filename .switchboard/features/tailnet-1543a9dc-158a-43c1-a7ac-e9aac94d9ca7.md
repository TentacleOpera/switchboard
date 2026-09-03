# Tailnet

<!-- board-collapse-05 -->
> **Landing order is fixed, not advisory (2026-09-04, Board Collapse 05, decision 7).**
> 
> 1. **Tailnet Mode Accepts The Node's Own MagicDNS Names** — populates the bind policy with `Self.DNSName` / `Self.HostName` / tailnet addresses. Only its IPv6 listener remains; changes 1 to 6 already shipped.
> 2. **The tailnet URL is chosen for reachability, never for origin trust** — emits the best-trust origin.
> 3. **`switchboard tailnet` prints the credential-free URL and then opens the credentialed one** — the CLI opens the URL it printed.
> 4. **The browser board is served unauthenticated** — the CSRF guard, whose allow-set reads the bind policy step 1 fills.
> 
> Reversing 1 and 4 is the failure this feature exists to prevent: a CSRF guard that accepts only loopback origins returns 403 for every verb triggered from the tailnet board, and does so invisibly, because a verb POST has no timeout and a rejection is indistinguishable from a hang.
> 
> **Column note.** Two subtasks (MagicDNS, tailnet URL) were in Planned and two in New when this feature was formed. Under the containment rule signed on 2026-09-04 a feature takes its least-advanced member's column, so all four now sit in New with the feature. That is the safe direction — promoting unreviewed plans into a dispatchable column risks coding unreviewed work — but it does cost the record of those two reviews. **They have both been plan-reviewed already**; when this feature is promoted, they need a sequencing check against the order above, not a fresh review.


**Complexity:** 5

## Goal

The board reached over the tailnet is trusted, correctly addressed, and protected. Landing order is fixed and not optional: MagicDNS names populate the bind policy first, then the URL is chosen for origin trust, then the CLI opens the credential-free URL, then the CSRF guard reads that same bind policy as its allow-set. Reversing the first and last steps makes the guard reject every request from the tailnet board.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The browser board is served unauthenticated by the extension host — reject cross-site state-changing requests in both hosts](../plans/browser-board-csrf-cross-site-rejection.md) — **CREATED** — ID: 2ce0ff70-af28-4b22-a338-665ddbc608cb
- [ ] [Tailnet Mode Accepts The Node's Own MagicDNS Names Without Being Told Them](../plans/tailnet-accepts-the-nodes-own-magicdns-names.md) — **CREATED** — ID: 61382b30-ba2a-4d97-aade-282d249ab05d
- [ ] [The tailnet URL is chosen for reachability, never for origin trust, so the board lands on an insecure context that cannot install to a Home Screen](../plans/the-tailnet-url-never-offers-a-secure-origin.md) — **CREATED** — ID: be0cf7de-bd11-4ee3-b999-5da0dde9e105
- [ ] [`switchboard tailnet` prints the credential-free tailnet URL and then opens the credentialed loopback one, which arrives already spent](../plans/tailnet-mode-opens-the-loopback-board-and-spends-its-token.md) — **CREATED** — ID: eddb76a9-bc8e-4de5-b51d-b13a8c0bac4d
<!-- END SUBTASKS -->

