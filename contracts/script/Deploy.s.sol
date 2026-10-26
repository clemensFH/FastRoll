// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CourseToken} from "../src/CourseToken.sol";
import {Escrow} from "../src/Escrow.sol";
import {Gateway} from "../src/Gateway.sol";
import {Registry} from "../src/Registry.sol";
import {MerkleLib} from "../src/lib/MerkleLib.sol";

/// @notice Deploys one L2's L1 side: token, registry, gateway, escrow.
///
/// Anvil:  forge script contracts/script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $PK
///
/// Env:
///   L2_ID             default 1
///   CHALLENGE_WINDOW  L1 blocks; 0 gives Task 2 semantics, where the committee
///                     is simply trusted and withdrawals pay out at once
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);
        uint32 l2Id = uint32(vm.envOr("L2_ID", uint256(1)));
        uint64 window = uint64(vm.envOr("CHALLENGE_WINDOW", uint256(0)));

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();

        CourseToken token = new CourseToken(deployer);
        Registry registry = new Registry(deployer);

        // Escrow and Gateway reference each other, so predict the gateway
        // address rather than adding a setter that would also let it be moved.
        uint64 nonce = vm.getNonce(deployer);
        address predictedGateway = vm.computeCreateAddress(deployer, nonce + 1);
        Escrow escrow = new Escrow(address(token), predictedGateway);
        // The genesis root is the root of an all-empty tree, not zero. Zero
        // looks harmless because nothing compares against the pre-state root
        // until somebody challenges a batch, and then every honest witness for
        // the first batch is rejected.
        Gateway gateway =
            new Gateway(address(registry), address(escrow), l2Id, MerkleLib.EMPTY_ROOT, window, deployer);
        require(address(gateway) == predictedGateway, "gateway address prediction failed");

        registry.setGateway(address(gateway));

        // Nothing is sealed, here or anywhere: an epoch's committee is the
        // stakes as they stood at its start, so validators bond and sit from
        // the next epoch.
        vm.stopBroadcast();

        console.log("CourseToken", address(token));
        console.log("Registry   ", address(registry));
        console.log("Escrow     ", address(escrow));
        console.log("Gateway    ", address(gateway));
        console.log("l2Id       ", l2Id);
        console.log("chainId    ", gateway.chainId());
        console.log("window     ", window);
        // Machine-readable block. The grader parses these lines, so any
        // deployment path a student writes has to print the same four.
        console.log("ATBT_TOKEN=", address(token));
        console.log("ATBT_REGISTRY=", address(registry));
        console.log("ATBT_ESCROW=", address(escrow));
        console.log("ATBT_GATEWAY=", address(gateway));
        console.log("next: stake validators; they sit from the next epoch");
    }
}
