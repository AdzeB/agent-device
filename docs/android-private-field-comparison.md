# Private Android field comparison

`agent-device compare-field --private-stdin --json --platform android --session NAME -- @eN~sG`
accepts one stdin JSON object with exactly `protocol: "android-private-input-v1"`, a UUID
`requestId`, and string `expectedValue`. Supply this object through a private process pipe;
do not put the expected value in shell arguments. The envelope limit is 32 KiB and the
expected value limit is 16 KiB in UTF-8. Stdin must finish within ten seconds.

This operator entry maps to the existing `get attrs` session and ref ownership route.
It requires an explicit Android platform, named session, and versioned ref. It does not
expose expected input through the ordinary command schema or model-facing tools.
The expected value is attached only during final local socket serialization and removed
before daemon request handling, authentication, cloning, or diagnostics. Remote HTTP is
unsupported. There is no transport retry for a private request.

One-shot asynchronous request context holds the private input independently of caller IDs;
it is cleared on completion, exception, request cancellation, or after sixty seconds.
An expired or reused private context fails closed. Ordinary `get attrs` requests have no
private context. Native comparison requires the original versioned field identity and fresh
focus, application, window, and input-connection evidence. Results contain an equality
status and bounded provenance; neither observed nor expected text is returned.
