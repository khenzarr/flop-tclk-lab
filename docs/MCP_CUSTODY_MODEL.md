# MCP custody model

## Local/stdio

The stdio package reads optional `TECHNOCORE_SIGNING_KEY` (Ed25519 transport seed) and `TCLK_PAYMENT_KEY` (secp256k1 scalar for adaptor pre-signing) from its process environment. It exposes only public DID/payment identity, not the keys. A minted hash preimage or point witness is returned in the minting response and is not stored or echoed by later transcript application. This still means the caller and its process are responsible for custody.

`tclk_post_frame` has three modes: caller-supplied `did` + `sig` + `nonce` pass through; configured stdio signing signs `<room>|<nonce>|<text>`; with no identity it returns that exact challenge and nonce without making an HTTP call. Partial signature triples are rejected.

## Hosted/no-custody Worker

The Worker does not read or bind either custody environment variable. It supports caller-supplied signatures and the challenge response, but cannot sign on behalf of callers. Its adaptor pre-sign tool refuses because it holds no payment key; public-input adapt/extract/verify remain possible. It deliberately writes no request/result logs because reveal lines can contain secrets. Shared hosting therefore avoids one operator identity signing for every caller and avoids operator custody of payment keys, while callers still must protect their own secrets and budget/rate limits are venue/deployment concerns, not settlement guarantees.

## Boundary conclusion

Neither MCP mode should receive the canonical local DID seed. A signature or caller-supplied transport credential may cross the posting boundary; the seed may not.
