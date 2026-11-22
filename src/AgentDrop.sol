// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @title PacketVault — holds the funds of exactly one packet
/// @dev Deployed once as an implementation; every packet gets its own minimal-proxy clone, so a
///      misbehaving token (fee-on-send, rebasing, lying balanceOf) can only affect its own packet.
///      Only the AgentDrop contract that deployed the implementation can move funds out.
contract PacketVault {
    using SafeERC20 for IERC20;

    address public immutable drop;

    error OnlyDrop();
    error TransferFailed();

    constructor() {
        drop = msg.sender;
    }

    /// @dev Only the drop forwards BNB here; anything else would be locked, so it is refused.
    receive() external payable {
        if (msg.sender != drop) revert OnlyDrop();
    }

    function pay(address token, address to, uint256 amount) external {
        if (msg.sender != drop) revert OnlyDrop();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}

/// @title AgentDrop — red packets / airdrops that only real agents can open
/// @notice Anyone can fund a packet with BNB or a BEP-20 token. Only addresses holding an Agent ID
///         (soulbound, one per person) can open it, once per packet.
/// @dev    Immutable: no owner, no admin, no fees, no upgrade, no pause. Funds of each packet sit in
///         that packet's own vault and can only go to (a) claimers, their share, or (b) after expiry,
///         the creator (or an address the creator itself chooses).
contract AgentDrop is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    uint8 public constant MODE_EQUAL = 0;
    uint8 public constant MODE_LUCKY = 1;

    uint32 public constant MAX_SHARES = 1000;
    uint64 public constant MIN_DURATION = 10 minutes;
    uint64 public constant MAX_DURATION = 30 days;
    uint256 internal constant GATE_GAS = 50_000;

    /// Reasons returned by canClaim (0 = OK).
    uint8 public constant OK = 0;
    uint8 public constant R_NOT_FOUND = 1;
    uint8 public constant R_EXPIRED = 2;
    uint8 public constant R_EMPTY = 3;
    uint8 public constant R_NO_AGENT_ID = 4;
    uint8 public constant R_ALREADY_CLAIMED = 5;
    uint8 public constant R_GATE = 6;
    uint8 public constant R_BAD_CODE = 7;

    /// @notice The Agent ID (SPACE ID) contract; on BNB Chain 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F.
    IERC721 public immutable agentId;
    /// @notice Implementation every packet vault clones.
    address public immutable vaultImpl;

    // ---------------------------------------------------------------- storage

    struct Packet {
        address creator;
        uint64 expiresAt;
        uint32 shares;
        uint32 claimed;
        uint8 mode;
        address token; // address(0) = BNB
        uint128 total; // amount the vault actually received at creation
        uint128 remaining;
        address gateToken; // address(0) = no holding requirement
        uint128 gateMin;
        address vault;
        bytes32 codeHash; // bytes32(0) = no code; else keccak256(abi.encode(creator, code))
        bytes32 seed; // fixed at creation; lucky amounts derive from (seed, claim index, claimer)
    }

    struct CreateParams {
        address token;
        uint128 amount;
        uint32 shares;
        uint8 mode;
        uint64 duration;
        bytes32 codeHash;
        address gateToken;
        uint128 gateMin;
    }

    uint256 public packetCount;
    mapping(uint256 => Packet) internal _packets;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    // ---------------------------------------------------------------- events

    event PacketCreated(
        uint256 indexed id,
        address indexed creator,
        address indexed token,
        uint128 total,
        uint32 shares,
        uint8 mode,
        uint64 expiresAt,
        bool hasCode,
        address gateToken,
        uint128 gateMin,
        address vault
    );
    event Claimed(uint256 indexed id, address indexed claimer, uint128 amount, uint32 claimedCount);
    event Refunded(uint256 indexed id, address indexed to, uint128 amount);

    // ---------------------------------------------------------------- errors

    error InvalidParams();
    error WrongValue();
    error NothingReceived();
    error CannotClaim(uint8 reason);
    error PacketNotFound();
    error NotExpired();
    error NothingToRefund();
    error OnlyCreator();
    error TransferFailed();

    constructor(IERC721 agentId_) {
        if (address(agentId_).code.length == 0) revert InvalidParams();
        agentId = agentId_;
        vaultImpl = address(new PacketVault());
    }

    // ---------------------------------------------------------------- create

    /// @notice Create a packet. For BNB send exactly `amount` as msg.value. For a BEP-20 approve exactly
    ///         `amount` first; the packet records what actually arrived in its vault.
    function createPacket(CreateParams calldata p) external payable nonReentrant returns (uint256 id) {
        if (
            p.shares == 0 || p.shares > MAX_SHARES || p.mode > MODE_LUCKY || p.duration < MIN_DURATION
                || p.duration > MAX_DURATION || p.amount == 0
        ) revert InvalidParams();
        if (p.gateToken == address(0)) {
            if (p.gateMin != 0) revert InvalidParams();
        } else if (p.gateMin == 0 || p.gateToken.code.length == 0) {
            revert InvalidParams();
        }
        if (p.token != address(0) && p.token.code.length == 0) revert InvalidParams();

        id = ++packetCount;
        address vault = Clones.cloneDeterministic(vaultImpl, bytes32(id));

        uint256 received;
        if (p.token == address(0)) {
            if (msg.value != p.amount) revert WrongValue();
            (bool ok,) = vault.call{value: msg.value}("");
            if (!ok) revert TransferFailed();
            received = p.amount;
        } else {
            if (msg.value != 0) revert WrongValue();
            IERC20 t = IERC20(p.token);
            uint256 before = t.balanceOf(vault);
            t.safeTransferFrom(msg.sender, vault, p.amount);
            uint256 afterBal = t.balanceOf(vault);
            if (afterBal <= before) revert NothingReceived();
            received = afterBal - before;
            if (received > p.amount) received = p.amount; // never credit more than was sent
        }
        if (received < p.shares) revert InvalidParams(); // every share gets >= 1 unit

        uint64 expiresAt = uint64(block.timestamp) + p.duration;
        _packets[id] = Packet({
            creator: msg.sender,
            expiresAt: expiresAt,
            shares: p.shares,
            claimed: 0,
            mode: p.mode,
            token: p.token,
            total: uint128(received),
            remaining: uint128(received),
            gateToken: p.gateToken,
            gateMin: p.gateMin,
            vault: vault,
            codeHash: p.codeHash,
            seed: keccak256(abi.encode(blockhash(block.number - 1), block.prevrandao, msg.sender, id))
        });

        emit PacketCreated(
            id,
            msg.sender,
            p.token,
            uint128(received),
            p.shares,
            p.mode,
            expiresAt,
            p.codeHash != bytes32(0),
            p.gateToken,
            p.gateMin,
            vault
        );
    }

    // ---------------------------------------------------------------- claim

    /// @notice Open a packet. Caller must hold an Agent ID and not have opened this packet before.
    /// @param code The packet's code ("" when the packet has none).
    function claim(uint256 id, string calldata code) external nonReentrant returns (uint128 amount) {
        uint8 reason = _check(id, msg.sender, code);
        if (reason != OK) revert CannotClaim(reason);

        Packet storage pk = _packets[id];
        uint32 left = pk.shares - pk.claimed;
        amount = _shareAmount(pk, msg.sender, left);

        hasClaimed[id][msg.sender] = true;
        pk.claimed += 1;
        pk.remaining -= amount;

        emit Claimed(id, msg.sender, amount, pk.claimed);
        PacketVault(payable(pk.vault)).pay(pk.token, msg.sender, amount);
    }

    // ---------------------------------------------------------------- refund

    /// @notice After expiry anyone may trigger the refund; the remainder goes to the creator.
    function refund(uint256 id) external nonReentrant {
        Packet storage pk = _packets[id];
        _refund(id, pk, pk.creator);
    }

    /// @notice After expiry the creator may send the remainder to another address (e.g. when the creator
    ///         address cannot receive BNB or is blocked by the token).
    function refundTo(uint256 id, address to) external nonReentrant {
        Packet storage pk = _packets[id];
        if (msg.sender != pk.creator || pk.creator == address(0)) revert OnlyCreator();
        if (to == address(0)) revert InvalidParams();
        _refund(id, pk, to);
    }

    function _refund(uint256 id, Packet storage pk, address to) internal {
        if (pk.creator == address(0)) revert PacketNotFound();
        if (block.timestamp < pk.expiresAt) revert NotExpired();
        uint128 amount = pk.remaining;
        if (amount == 0) revert NothingToRefund();
        pk.remaining = 0;
        emit Refunded(id, to, amount);
        PacketVault(payable(pk.vault)).pay(pk.token, to, amount);
    }

    // ---------------------------------------------------------------- views

    function getPacket(uint256 id) external view returns (Packet memory) {
        return _packets[id];
    }

    /// @notice Pre-check for agents and the web page. Returns 0 when `who` can claim with `code`.
    ///         Checks run in this order: exists, not expired, not empty, not already claimed, holds an
    ///         Agent ID, meets the gate, code matches — so a call with an empty code returns R_BAD_CODE
    ///         only when everything except the code is fine.
    function canClaim(uint256 id, address who, string calldata code) external view returns (uint8) {
        return _check(id, who, code);
    }

    /// @notice Same hashing as the contract uses; clients should compute it locally (keccak256(abi.encode)).
    function hashCode(address creator, string calldata code) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, code));
    }

    // ---------------------------------------------------------------- internal

    function _check(uint256 id, address who, string calldata code) internal view returns (uint8) {
        Packet storage pk = _packets[id];
        if (pk.creator == address(0)) return R_NOT_FOUND;
        if (block.timestamp >= pk.expiresAt) return R_EXPIRED;
        if (pk.claimed >= pk.shares || pk.remaining == 0) return R_EMPTY;
        if (hasClaimed[id][who]) return R_ALREADY_CLAIMED;
        if (agentId.balanceOf(who) == 0) return R_NO_AGENT_ID;
        if (pk.gateToken != address(0) && !_meetsGate(pk.gateToken, who, pk.gateMin)) return R_GATE;
        if (pk.codeHash != bytes32(0) && hashCode(pk.creator, code) != pk.codeHash) return R_BAD_CODE;
        return OK;
    }

    /// @dev A broken gate token makes the gate fail instead of reverting the whole claim path.
    ///      Gas is capped and only the first 32 bytes of return data are copied, so a hostile gate token
    ///      cannot burn the caller's gas.
    function _meetsGate(address token, address who, uint128 min) internal view returns (bool) {
        bytes memory data = abi.encodeCall(IERC20.balanceOf, (who));
        bool ok;
        uint256 size;
        uint256 bal;
        assembly ("memory-safe") {
            ok := staticcall(GATE_GAS, token, add(data, 0x20), mload(data), 0x00, 0x20)
            size := returndatasize()
            bal := mload(0x00)
        }
        return ok && size >= 32 && bal >= min;
    }

    /// @dev Invariant: after paying, remaining >= left - 1, so every later share gets >= 1 unit.
    ///      Lucky amounts depend only on (seed fixed at creation, claim index, claimer) — not on the block
    ///      of the claim — so reverting and retrying cannot improve a claimer's draw.
    function _shareAmount(Packet storage pk, address claimer, uint32 left) internal view returns (uint128) {
        uint128 rem = pk.remaining;
        if (left == 1) return rem;
        if (pk.mode == MODE_EQUAL) return rem / left;

        uint256 maxAmt = (uint256(rem) * 2) / left; // >= 2 because rem >= left
        uint256 rand = uint256(keccak256(abi.encode(pk.seed, pk.claimed, claimer)));
        uint256 amt = 1 + (rand % maxAmt); // [1, 2*avg]
        uint256 cap = uint256(rem) - (left - 1);
        if (amt > cap) amt = cap;
        return uint128(amt);
    }
}
