// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Escrow} from "../src/Escrow.sol";
import {Gateway} from "../src/Gateway.sol";
import {Registry} from "../src/Registry.sol";
import {MerkleLib} from "../src/lib/MerkleLib.sol";

/// @notice One group's rollup on the hosted L1: its registry, its escrow and
///         its Gateway, against the course token that DeployCourse deployed.
///         The same as Deploy.s.sol, which the grader runs, except that the
///         token already exists and is not ours to deploy.
///
/// Env:
///   TOKEN             the course token, from DeployCourse
///   L2_ID             your group's number
///   CHALLENGE_WINDOW  L1 blocks; 0 gives Task 2 semantics
///
/// forge script contracts/script/DeployRollup.s.sol --rpc-url $L1_RPC --broadcast --private-key $GROUP_KEY
contract DeployRollup is Script {
    function run() external {
        address token = vm.envAddress("TOKEN");
        uint32 l2Id = uint32(vm.envUint("L2_ID"));
        uint64 window = uint64(vm.envOr("CHALLENGE_WINDOW", uint256(0)));

        // Only the broadcasting key, from --private-key, never an exported
        // PRIVATE_KEY that would silently deploy as somebody else.
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        Registry registry = new Registry(deployer);
        // Escrow and Gateway reference each other, so predict the gateway
        // address rather than adding a setter that would also let it be moved.
        address predictedGateway = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        Escrow escrow = new Escrow(token, predictedGateway);
        Gateway gateway =
            new Gateway(address(registry), address(escrow), l2Id, MerkleLib.EMPTY_ROOT, window, deployer);
        require(address(gateway) == predictedGateway, "gateway address prediction failed");
        registry.setGateway(address(gateway));
        vm.stopBroadcast();

        console.log("l2Id       ", l2Id);
        console.log("chainId    ", gateway.chainId());
        console.log("ATBT_TOKEN=", token);
        console.log("ATBT_REGISTRY=", address(registry));
        console.log("ATBT_ESCROW=", address(escrow));
        console.log("ATBT_GATEWAY=", address(gateway));
        console.log(
            "next: RegisterGateway.s.sol with your operator key, then stake; validators sit from the next epoch"
        );
    }
}
