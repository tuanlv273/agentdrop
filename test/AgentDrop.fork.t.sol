// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentDrop} from "../src/AgentDrop.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// Runs against a BNB Chain mainnet fork with the real Agent ID contract.
/// BSC_RPC_URL=https://bsc-rpc.publicnode.com forge test --match-contract Fork
contract AgentDropForkTest is Test {
    IERC721 constant AGENT_ID = IERC721(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F);
    address constant HOLDER = 0xd70e65fF85be4812920aFEFb367Eef12b47A0971; // minted an Agent ID 2026-11-18

    AgentDrop drop;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        drop = new AgentDrop(AGENT_ID);
    }

    function test_fork_realAgentIdGate() public {
        if (!forked) return;
        assertGt(AGENT_ID.balanceOf(HOLDER), 0, "holder has Agent ID");

        address creator = makeAddr("creator");
        vm.deal(creator, 1 ether);
        AgentDrop.CreateParams memory p;
        p.amount = 0.01 ether;
        p.shares = 2;
        p.duration = 1 days;
        vm.prank(creator);
        uint256 id = drop.createPacket{value: 0.01 ether}(p);

        address nobody = makeAddr("nobody");
        assertEq(drop.canClaim(id, nobody, ""), drop.R_NO_AGENT_ID());

        uint256 before = HOLDER.balance;
        vm.prank(HOLDER);
        drop.claim(id, "");
        assertEq(HOLDER.balance - before, 0.005 ether);
    }
}
