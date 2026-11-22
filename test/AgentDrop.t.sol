// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentDrop, PacketVault} from "../src/AgentDrop.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockAgentId is ERC721("Agent ID", "AI") {
    uint256 next;

    function mint(address to) external {
        _mint(to, ++next);
    }
}

contract MockToken is ERC20("Mock", "MCK") {
    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// Takes a 10% fee on every transfer.
contract FeeToken is ERC20("Fee", "FEE") {
    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = v / 10;
            super._update(from, address(0xdead), fee);
            v -= fee;
        }
        super._update(from, to, v);
    }
}

/// Charges the SENDER an extra 10% on every transfer (sender-side tax).
contract SendTaxToken is ERC20("Tax", "TAX") {
    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) super._update(from, address(0xdead), v / 10);
        super._update(from, to, v);
    }
}

/// A creator contract that cannot receive BNB.
contract NonPayableCreator {
    AgentDrop drop;

    constructor(AgentDrop d) {
        drop = d;
    }

    function create(uint128 amount) external returns (uint256) {
        AgentDrop.CreateParams memory p;
        p.amount = amount;
        p.shares = 1;
        p.duration = 1 days;
        return drop.createPacket{value: amount}(p);
    }

    function rescue(uint256 id, address to) external {
        drop.refundTo(id, to);
    }
}

/// Gate token that burns gas and returns huge data.
contract HostileGate {
    function balanceOf(address) external pure returns (uint256) {
        assembly {
            let i := 0
            for {} lt(i, 100000) { i := add(i, 1) } {}
            return(0, 1000000)
        }
    }
}

/// Claims again from inside the BNB payout.
contract Reenterer {
    AgentDrop drop;
    uint256 id;
    bool tried;
    bool public reentryFailed;

    constructor(AgentDrop d) {
        drop = d;
    }

    function go(uint256 _id) external {
        id = _id;
        drop.claim(_id, "");
    }

    receive() external payable {
        if (!tried) {
            tried = true;
            try drop.claim(id, "") {}
            catch {
                reentryFailed = true;
            }
        }
    }
}

contract AgentDropTest is Test {
    AgentDrop drop;
    MockAgentId aid;
    MockToken tok;

    address creator = makeAddr("creator");
    address[] agents;

    function setUp() public {
        aid = new MockAgentId();
        drop = new AgentDrop(IERC721(address(aid)));
        tok = new MockToken();
        vm.deal(creator, 100 ether);
        tok.mint(creator, 1_000_000 ether);
        for (uint256 i; i < 50; i++) {
            address a = makeAddr(string(abi.encodePacked("agent", vm.toString(i))));
            aid.mint(a);
            agents.push(a);
        }
    }

    function _params(address token, uint128 amount, uint32 shares, uint8 mode)
        internal
        pure
        returns (AgentDrop.CreateParams memory p)
    {
        p.token = token;
        p.amount = amount;
        p.shares = shares;
        p.mode = mode;
        p.duration = 1 days;
    }

    function _createBnb(uint128 amount, uint32 shares, uint8 mode) internal returns (uint256) {
        vm.prank(creator);
        return drop.createPacket{value: amount}(_params(address(0), amount, shares, mode));
    }

    // ------------------------------------------------------------ basics

    function test_equalBnb_allSharesExact() public {
        uint256 id = _createBnb(1 ether, 3, 0);
        uint256 sum;
        for (uint256 i; i < 3; i++) {
            uint256 b = agents[i].balance;
            vm.prank(agents[i]);
            drop.claim(id, "");
            sum += agents[i].balance - b;
        }
        assertEq(sum, 1 ether, "total paid == total funded");
        assertEq(address(drop).balance, 0);
        vm.prank(agents[3]);
        vm.expectRevert(abi.encodeWithSelector(AgentDrop.CannotClaim.selector, drop.R_EMPTY()));
        drop.claim(id, "");
    }

    function test_noAgentId_rejected() public {
        uint256 id = _createBnb(1 ether, 3, 0);
        address stranger = makeAddr("stranger");
        assertEq(drop.canClaim(id, stranger, ""), drop.R_NO_AGENT_ID());
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentDrop.CannotClaim.selector, drop.R_NO_AGENT_ID()));
        drop.claim(id, "");
    }

    function test_doubleClaim_rejected() public {
        uint256 id = _createBnb(1 ether, 3, 0);
        vm.startPrank(agents[0]);
        drop.claim(id, "");
        vm.expectRevert(abi.encodeWithSelector(AgentDrop.CannotClaim.selector, drop.R_ALREADY_CLAIMED()));
        drop.claim(id, "");
        vm.stopPrank();
    }

    function test_code_required() public {
        AgentDrop.CreateParams memory p = _params(address(0), 1 ether, 2, 0);
        p.codeHash = drop.hashCode(creator, "TET2026");
        vm.prank(creator);
        uint256 id = drop.createPacket{value: 1 ether}(p);

        uint8 badCode = drop.R_BAD_CODE();
        vm.prank(agents[0]);
        vm.expectRevert(abi.encodeWithSelector(AgentDrop.CannotClaim.selector, badCode));
        drop.claim(id, "WRONG");

        vm.prank(agents[0]);
        drop.claim(id, "TET2026");
        assertTrue(drop.hasClaimed(id, agents[0]));
    }

    function test_gateToken() public {
        AgentDrop.CreateParams memory p = _params(address(0), 1 ether, 2, 0);
        p.gateToken = address(tok);
        p.gateMin = 100 ether;
        vm.prank(creator);
        uint256 id = drop.createPacket{value: 1 ether}(p);

        assertEq(drop.canClaim(id, agents[0], ""), drop.R_GATE());
        tok.mint(agents[0], 100 ether);
        assertEq(drop.canClaim(id, agents[0], ""), drop.OK());
    }

    function test_expiry_and_refund() public {
        uint256 id = _createBnb(1 ether, 4, 0);
        vm.prank(agents[0]);
        drop.claim(id, "");

        vm.expectRevert(AgentDrop.NotExpired.selector);
        drop.refund(id);

        vm.warp(block.timestamp + 1 days);
        assertEq(drop.canClaim(id, agents[1], ""), drop.R_EXPIRED());

        uint256 before = creator.balance;
        vm.prank(agents[9]); // anyone can trigger, funds go to creator
        drop.refund(id);
        assertEq(creator.balance - before, 0.75 ether);
        vm.expectRevert(AgentDrop.NothingToRefund.selector);
        drop.refund(id);
    }

    // ------------------------------------------------------------ ERC-20

    function test_erc20_equal() public {
        vm.startPrank(creator);
        tok.approve(address(drop), 900 ether);
        uint256 id = drop.createPacket(_params(address(tok), 900 ether, 3, 0));
        vm.stopPrank();
        assertEq(tok.allowance(creator, address(drop)), 0, "exact approval consumed");
        for (uint256 i; i < 3; i++) {
            vm.prank(agents[i]);
            drop.claim(id, "");
            assertEq(tok.balanceOf(agents[i]), 300 ether);
        }
    }

    function test_feeToken_creditsActualReceived() public {
        FeeToken f = new FeeToken();
        f.mint(creator, 1000 ether);
        vm.startPrank(creator);
        f.approve(address(drop), 1000 ether);
        uint256 id = drop.createPacket(_params(address(f), 1000 ether, 2, 0));
        vm.stopPrank();
        assertEq(drop.getPacket(id).total, 900 ether);
        // both claims succeed: contract never owes more than it holds
        vm.prank(agents[0]);
        drop.claim(id, "");
        vm.prank(agents[1]);
        drop.claim(id, "");
        assertEq(f.balanceOf(drop.getPacket(id).vault), 0);
    }

    // ------------------------------------------------------------ params

    function test_invalidParams() public {
        vm.startPrank(creator);
        vm.expectRevert(AgentDrop.InvalidParams.selector);
        drop.createPacket{value: 1 ether}(_params(address(0), 1 ether, 0, 0));
        vm.expectRevert(AgentDrop.InvalidParams.selector);
        drop.createPacket{value: 1 ether}(_params(address(0), 1 ether, 1001, 0));
        vm.expectRevert(AgentDrop.InvalidParams.selector);
        drop.createPacket{value: 1 ether}(_params(address(0), 1 ether, 2, 2));
        vm.expectRevert(AgentDrop.InvalidParams.selector);
        drop.createPacket{value: 3}(_params(address(0), 3, 5, 0)); // less than 1 unit per share
        vm.expectRevert(AgentDrop.WrongValue.selector);
        drop.createPacket{value: 0.5 ether}(_params(address(0), 1 ether, 2, 0));
        AgentDrop.CreateParams memory p = _params(address(0), 1 ether, 2, 0);
        p.duration = 31 days;
        vm.expectRevert(AgentDrop.InvalidParams.selector);
        drop.createPacket{value: 1 ether}(p);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ security

    function test_reentrancy_blocked() public {
        uint256 id = _createBnb(1 ether, 5, 0);
        Reenterer r = new Reenterer(drop);
        aid.mint(address(r));
        r.go(id);
        assertTrue(r.reentryFailed(), "re-entry must fail");
        assertEq(drop.getPacket(id).claimed, 1);
    }

    function test_gateToken_mustBeContract_andMinPositive() public {
        AgentDrop.CreateParams memory p = _params(address(0), 1 ether, 2, 0);
        p.gateToken = makeAddr("eoa");
        p.gateMin = 1;
        vm.prank(creator);
        vm.expectRevert(AgentDrop.InvalidParams.selector);
        drop.createPacket{value: 1 ether}(p);
        p.gateToken = address(tok);
        p.gateMin = 0;
        vm.prank(creator);
        vm.expectRevert(AgentDrop.InvalidParams.selector);
        drop.createPacket{value: 1 ether}(p);
    }

    function test_refundTo_onlyCreator_and_nonPayableCreator() public {
        NonPayableCreator npc = new NonPayableCreator(drop);
        vm.deal(address(npc), 1 ether);
        uint256 id = npc.create(0.5 ether);
        vm.warp(block.timestamp + 1 days);

        vm.expectRevert(PacketVault.TransferFailed.selector);
        drop.refund(id); // creator cannot receive BNB

        vm.prank(agents[0]);
        vm.expectRevert(AgentDrop.OnlyCreator.selector);
        drop.refundTo(id, agents[0]); // third parties can never pick the destination

        address safe = makeAddr("safe");
        npc.rescue(id, safe);
        assertEq(safe.balance, 0.5 ether);
    }

    function test_refund_unknownPacket() public {
        vm.expectRevert(AgentDrop.PacketNotFound.selector);
        drop.refund(999);
    }

    /// A token that charges the sender extra on every transfer cannot eat into another packet.
    function test_isolation_sendTaxToken() public {
        SendTaxToken s = new SendTaxToken();
        s.mint(creator, 1000 ether);
        vm.startPrank(creator);
        s.approve(address(drop), 200 ether);
        uint256 a = drop.createPacket(_params(address(s), 100 ether, 1, 0));
        uint256 b = drop.createPacket(_params(address(s), 100 ether, 1, 0));
        vm.stopPrank();

        vm.prank(agents[0]);
        vm.expectRevert(); // packet A's vault cannot cover the extra tax
        drop.claim(a, "");

        // packet B is untouched: its vault still holds what it was credited
        assertEq(s.balanceOf(drop.getPacket(b).vault), drop.getPacket(b).remaining);
    }

    /// Lucky draws do not depend on the claim block, so retrying later cannot improve the amount.
    function test_lucky_notRerollable() public {
        uint256 id = _createBnb(1 ether, 10, 1);
        uint256 snap = vm.snapshotState();
        vm.prank(agents[0]);
        uint128 first = drop.claim(id, "");
        vm.revertToState(snap);
        vm.roll(block.number + 100);
        vm.warp(block.timestamp + 60);
        vm.prevrandao(bytes32(uint256(12345)));
        vm.prank(agents[0]);
        uint128 second = drop.claim(id, "");
        assertEq(first, second);
    }

    function test_vaults_onlyDropCanPay() public {
        uint256 id = _createBnb(1 ether, 2, 0);
        PacketVault v = PacketVault(payable(drop.getPacket(id).vault));
        vm.expectRevert(PacketVault.OnlyDrop.selector);
        v.pay(address(0), address(this), 1 ether);
    }

    function test_hostileGate_failsGracefully() public {
        HostileGate g = new HostileGate();
        AgentDrop.CreateParams memory p = _params(address(0), 1 ether, 2, 0);
        p.gateToken = address(g);
        p.gateMin = 1;
        vm.prank(creator);
        uint256 id = drop.createPacket{value: 1 ether}(p);
        assertEq(drop.canClaim{gas: 2_000_000}(id, agents[0], ""), drop.R_GATE());
    }

    function test_vault_rejectsDirectBnb() public {
        uint256 id = _createBnb(1 ether, 2, 0);
        address v = drop.getPacket(id).vault;
        vm.deal(address(this), 1 ether);
        (bool ok,) = v.call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------ fuzz

    /// Lucky and equal packets always pay out exactly the funded total, every share >= 1 unit.
    function testFuzz_conservation(uint128 amount, uint32 shares, bool lucky, uint256 seed) public {
        shares = uint32(bound(shares, 1, 50));
        amount = uint128(bound(amount, shares, 50 ether));
        uint256 id = _createBnb(amount, shares, lucky ? 1 : 0);
        uint256 sum;
        for (uint256 i; i < shares; i++) {
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode(seed, i)))));
            vm.roll(block.number + 1);
            uint256 b = agents[i].balance;
            vm.prank(agents[i]);
            drop.claim(id, "");
            uint256 got = agents[i].balance - b;
            assertGe(got, 1, "every share >= 1 unit");
            sum += got;
        }
        assertEq(sum, amount, "conservation");
        assertEq(drop.getPacket(id).remaining, 0);
    }
}
