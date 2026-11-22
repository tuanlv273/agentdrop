# AgentDrop

**On-chain red packets that only real agents can open.**

Anyone can drop BNB or a BEP-20 token on BNB Chain. Only wallets holding an **Agent ID** — the soulbound `name.ai`
identity of a Binance Agentic Wallet, one per person — can open a packet, and each Agent ID opens each packet once.
Every share reaches a different real person, never a farm of cloned wallets.

Built for the **BNB Chain × Binance Wallet Agent ID Hackathon**.

| | |
|---|---|
| AgentDrop (BNB Chain) | [`0x0f7Ad86c06531F67FCbe4D2D334acb56b2c51517`](https://bscscan.com/address/0x0f7Ad86c06531F67FCbe4D2D334acb56b2c51517#code) — verified |
| PacketVault implementation | [`0x60390C638e9656c652F126431d600527a9cF01DD`](https://bscscan.com/address/0x60390C638e9656c652F126431d600527a9cF01DD#code) — verified |
| Agent ID (SPACE ID, soulbound ERC-721) | [`0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`](https://bscscan.com/address/0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F) |
| Live page | https://tuanlv273.github.io/agentdrop/ (static, read-only, source in `web/`) |

## Why

Airdrops and giveaways on BNB Chain are drained by sybil farms: one person, hundreds of wallets. Agent ID is the first
widely-held on-chain identity where **one person = one ID and the ID cannot be transferred**. AgentDrop turns that
into a primitive: *"give this to N different real people"* — provable on-chain, with zero cloned wallets.

- **People** send lucky money (红包 / lì xì) to friends and communities by telling their agent one sentence.
- **Projects and KOLs** run sybil-resistant airdrops to N real agents, and can require holding their token.
- **Anyone** can verify every packet on-chain: who created it, how many real people opened it.

## How it works

```
creator ──createPacket──▶ AgentDrop ──clone──▶ PacketVault #id  (holds this packet's funds only)
                                │
agent (Agent ID holder) ──claim(id, code)──▶ checks ──▶ vault.pay(share) ──▶ agent
                                │
after expiry ──refund(id)──▶ vault.pay(remainder) ──▶ creator
```

`claim` succeeds only if: the packet exists, is not expired, has shares left, the caller has not opened it,
**`AgentID.balanceOf(caller) > 0`**, the optional gate (hold ≥ N of a token) passes, and the optional code matches.

| Feature | Detail |
|---|---|
| Split modes | `equal`, or `lucky` (random amounts, WeChat-style; every share ≥ 1 unit, sum = total) |
| Code | Optional secret code, stored as `keccak256(abi.encode(creator, code))`; hashed locally by the skill |
| Gate | Optional "must hold ≥ N of token X" |
| Shares / duration | 1–1000 shares, 10 minutes – 30 days |
| Refund | After expiry anyone can trigger `refund` (funds go to the creator); the creator alone can `refundTo` another address |

## Trust model

- **Immutable. No owner, no admin, no fee, no upgrade, no pause.** Nobody — including the deployer — can move funds
  except openers (their share) and, after expiry, the creator.
- **One vault per packet** (minimal-proxy clone). A broken or malicious token can only affect its own packet.
- **Exact-amount approvals** only; the skill never requests unlimited approvals.
- **No wallet connection on the web page, no QR login, no server-held sessions.** Every transaction is prepared by
  the user's own agent and confirmed by the user in their own Binance Agentic Wallet.
- Lucky amounts derive from a seed fixed at creation + claim index + claimer, so a claimer cannot re-roll by
  reverting. They are pseudo-random — fine for social packets, not for high-stakes randomness.

Reviewed twice (Claude code-review + OpenAI Codex) before deployment; all High/Medium findings fixed. See
`SECURITY.md`.

## Use it from your agent

Requirements: Binance Agentic Wallet (`baw`) with the `binance-agentic-wallet` skill, an Agent ID (to open packets),
and **Developer Mode** on (Binance App → Agentic Wallet → Settings → Developer Mode).

Install the skill next to `binance-agentic-wallet`:

```bash
cp -r skill/agentdrop ~/.claude/skills/agentdrop      # or your agent's skills folder
```

Then just ask:

- *"Open AgentDrop code K3RGW5M7"*
- *"Send a lucky AgentDrop packet of 0.01 BNB to 20 agents, random code, 24h"*
- *"Are there any AgentDrop packets I can open?"*

The helper `skill/agentdrop/scripts/agentdrop.mjs` (zero dependencies) only reads chain state and builds calldata;
it never signs. The agent always runs `baw contract-call preview`, shows the result, waits for the user's explicit
confirmation, then `execute`.

## Repository

| Path | What |
|---|---|
| `src/AgentDrop.sol` | `AgentDrop` + `PacketVault` |
| `test/` | Foundry tests: unit, 512-run fuzz (conservation), vault isolation, reentrancy, hostile gate, mainnet fork with the real Agent ID |
| `script/Deploy.s.sol` | Deployment (BNB Chain mainnet) |
| `skill/agentdrop/` | Agent skill (`SKILL.md` + zero-dependency helper) |
| `web/` | Static read-only page (reads BNB Chain directly) |
| `SECURITY.md` | Review findings, fixes and tested invariants |

```bash
forge test                                                  # unit + fuzz
BSC_RPC_URL=https://bsc-rpc.publicnode.com forge test       # + mainnet fork test
```

## Hackathon compliance

- Deployed on BNB Chain, source verified on BscScan and Sourcify, MIT licensed.
- Agent ID is the core of the product (the sybil-resistance guarantee), not a cosmetic name.
- No web QR login for Agentic Wallet, no server-side sessions, no bypassing user confirmation, no unlimited approvals,
  no collection of keys/seed phrases/API secrets/pairing codes, no "Binance"/"BNB" branding, no looking up other
  people's wallets by name, no promised returns.

## Disclaimer

AgentDrop is a gifting tool, not an investment product. Packets have no guaranteed value, and tokens in packets
created by others may be worthless. Use at your own risk.

## License

MIT
