# Security

AgentDrop was reviewed by two independent reviewers (Claude code-review and OpenAI Codex) before mainnet deployment,
then re-reviewed after fixes. No High or Medium findings remain.

## Findings and resolutions

| Finding | Severity | Resolution |
|---|---|---|
| Non-standard tokens (sender-side tax, negative rebase, lying `balanceOf`) could make other packets of the same token insolvent | High | Each packet holds its funds in its own `PacketVault` clone; a broken token only affects its own packet |
| Lucky split could be re-rolled by reverting; `prevrandao` on BNB Chain is near-constant | Medium | Lucky amount = f(seed fixed at creation, claim index, claimer); independent of the claim block |
| Creator that cannot receive BNB (or is token-blacklisted) would lock the refund | Low | `refundTo(id, to)`, callable only by the creator after expiry |
| Gate token that is an EOA or reverts would brick claims | Low | Gate must be a contract with `gateMin > 0`; checked with a gas-capped staticcall that fails closed |
| Hostile gate token returning huge data could exhaust gas | Low | Gate staticcall capped at 50,000 gas and copies only 32 bytes |
| BNB sent directly to a vault would be locked | Low | Vault `receive()` accepts BNB only from AgentDrop |
| Transferring an Agent ID between wallets to claim repeatedly | — | Not exploitable: verified on-chain that the Agent ID contract reverts `transferFrom`, `safeTransferFrom` and `approve` |
| Short human codes can be guessed offline / seen in the mempool | Accepted | The skill generates random 8-character codes by default; a guessed code still requires an Agent ID |
| Gate checks the balance at claim time (borrowable for one block) | Accepted | Documented; the Agent ID requirement still applies |

## Invariants (tested)

- Every share receives at least 1 smallest unit; the sum of all shares equals the amount credited at creation
  (512-run fuzz, equal and lucky modes).
- Each address opens a packet at most once; only Agent ID holders can open.
- Only AgentDrop can move vault funds; funds go only to openers or, after expiry, to the creator (or the creator's
  chosen address).
- Reentrancy through the BNB payout is blocked.

## Reporting

Please open a GitHub issue for non-sensitive reports. AgentDrop has no admin keys and cannot be paused or upgraded;
if a critical issue is found, the mitigation is to stop creating new packets and let existing ones expire and refund.
