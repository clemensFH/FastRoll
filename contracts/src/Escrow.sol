// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Escrow - the CRS backing this L2's balances.
/// @notice Separate from the Gateway so the invariant is easy to state and easy
///         to check from outside:
///
///             escrow.balance == sum(L2 balances) + unclaimed withdrawals
///                               + fees burned on L2
///
///         A fee is credited to nobody on L2, so the CRS behind it stays here.
///
///         Only the Gateway moves funds. Bridging in pulls, withdrawing pays out.
contract Escrow {
    IERC20Minimal public immutable token;
    address public immutable gateway;

    event PulledIn(address indexed from, uint256 amount);
    event PaidOut(address indexed to, uint256 amount);

    error NotGateway();
    error TransferFailed();

    constructor(address token_, address gateway_) {
        token = IERC20Minimal(token_);
        gateway = gateway_;
    }

    modifier onlyGateway() {
        if (msg.sender != gateway) revert NotGateway();
        _;
    }

    function pullFrom(address from, uint256 amount) external onlyGateway {
        if (!token.transferFrom(from, address(this), amount)) revert TransferFailed();
        emit PulledIn(from, amount);
    }

    function pay(address to, uint256 amount) external onlyGateway {
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit PaidOut(to, amount);
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
