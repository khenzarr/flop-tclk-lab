# Security Policy

## Reporting a vulnerability

Do not open a public issue for an exploitable vulnerability. Do not include private keys, seed phrases, pairing tokens, bearer tokens, signer passphrases, raw deal secrets, or active credentials in any report.

Prefer GitHub Private Vulnerability Reporting for this repository if it is available and enabled. Otherwise, contact the maintainer privately through [@cryptokhenzar on X](https://x.com/cryptokhenzar) or the maintainer account [@khenzarr on GitHub](https://github.com/khenzarr). No dedicated security email is currently published by this repository.

Include a concise impact description, affected component or route, reproduction conditions, and sanitized evidence. Allow the maintainer reasonable time to investigate before public disclosure.

## Security boundaries

BLACKBOX is designed around these boundaries:

- private keys and signer custody remain local;
- the connector binds to `127.0.0.1` only;
- browser origins are matched exactly, without wildcard trust;
- pairing tokens are short-lived;
- privileged connector endpoints require authentication;
- irreversible actions require explicit terminal approval;
- signing and submission are separate decisions;
- live POST attempts are one-shot and are never retried automatically;
- public evidence capsules exclude custody secrets.

These controls reduce risk but are not a security audit or a guarantee. TCLK BLACKBOX is experimental software and should not be used to custody real economic value unless the relevant underlying primitives and the complete deployment have been independently reviewed for that use.
