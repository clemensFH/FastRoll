# The protocol

The protocol description is the **FastRoll: Protocol Description** in the course hand-out (`FastRoll-Protocol-Description.pdf`, with the course materials). It is the reference for everything, and this file only points there.

Comments in the code refer to its sections by name, as `spec/SPEC.md`, "<section>". The names are the same in the hand-out, for example:

- Overview: "The system at a glance", "Units", "What is frozen", "The config file"
- Section 1: "Validator signing rule", "Aggregation", "Certificates", "Balances in standalone mode", "The four RPC interfaces"
- Section 2: "Signing against the L1 state", "The state tree", "The state transition", "The Gateway" (with "Posting" and "Bridging"), "Epochs", "Following L1", "The anchored validator", "Blocks"
- Section 3: "The four proofs", "Where the evidence comes from", "Two traps", "What the proofs cover", "False positives are worse than misses"
- Appendix: "The RPC interface in detail" (with "Parameters of requests", "Errors" and "Which refusal reason applies first")

The conformance vectors are here, in `spec/vectors/`, and `pnpm test` and `cargo test` check your code against them.
