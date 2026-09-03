# Threat Model

Inputs are hostile room text or imported local files. The importer caps input
at 1 MiB, requires `tclk-transcript/v1`, accepts only string lines, and rejects
known secret-bearing fields. Malformed frames become rejected replay steps.
No URLs are fetched, no HTML from input is rendered, and no credentials,
wallets, keys, or network writes are used. The demo embeds only safe replay
projections and capsules, never raw transcript lines.