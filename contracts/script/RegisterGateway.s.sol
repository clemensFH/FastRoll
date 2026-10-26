// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Router} from "../src/Router.sol";

/// @notice A group's operator key makes its newly deployed Gateway the one the
///         router deposits into. Run again after every redeploy: the previous
///         Gateway stays forwardable, so withdrawals made through it still arrive.
///
/// Env: ROUTER, L2_ID, GATEWAY, ESCROW (the last two from DeployRollup's output)
///
/// forge script contracts/script/RegisterGateway.s.sol --rpc-url $L1_RPC --broadcast --private-key $OPERATOR_KEY
contract RegisterGateway is Script {
    function run() external {
        Router router = Router(vm.envAddress("ROUTER"));
        uint32 l2Id = uint32(vm.envUint("L2_ID"));
        address gateway = vm.envAddress("GATEWAY");
        address escrow = vm.envAddress("ESCROW");
        // Only the broadcasting key, from --private-key.
        vm.startBroadcast();
        router.registerGateway(l2Id, gateway, escrow);
        vm.stopBroadcast();
        console.log("l2Id", l2Id, "now deposits into", gateway);
    }
}
