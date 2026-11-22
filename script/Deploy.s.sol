// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AgentDrop} from "../src/AgentDrop.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// Deploy with an encrypted keystore (no plaintext keys):
///   cast wallet import agentdrop-deployer --interactive
///   forge script script/Deploy.s.sol --rpc-url $BSC_RPC_URL --account agentdrop-deployer --broadcast \
///     --verify --etherscan-api-key $BSCSCAN_API_KEY
contract Deploy is Script {
    IERC721 constant AGENT_ID = IERC721(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F);

    function run() external returns (AgentDrop drop) {
        require(block.chainid == 56, "BNB Chain mainnet only");
        vm.startBroadcast();
        drop = new AgentDrop(AGENT_ID);
        vm.stopBroadcast();
        console.log("AgentDrop deployed at", address(drop));
    }
}
