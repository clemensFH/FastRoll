// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CourseToken (CRS) - the single token in the system.
/// @notice One token, not arbitrary ERC20s. Multi-token support adds accounting
///         surface, teaches nothing about protocols, and destroys the single
///         solvency invariant each rollup's escrow keeps:
///
///             escrow.balance == sum(L2 balances) + unclaimed withdrawals
///                               + fees burned on L2
///
///         Minimal implementation on purpose: this repo has no external
///         dependencies, so `forge build` works with no network access.
contract CourseToken {
    string public constant name = "CourseToken";
    string public constant symbol = "CRS";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// Lecture team. Mints the weekly refills that keep a drained group in the
    /// game rather than dead for the rest of the semester.
    address public owner;

    /// Faucet: rate limited per address so a script cannot drain it, generous
    /// enough that nobody is blocked on funding.
    uint256 public constant FAUCET_AMOUNT = 1_000 ether;
    uint256 public constant FAUCET_COOLDOWN = 6 hours;
    mapping(address => uint256) public lastFaucetAt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnerChanged(address indexed previous, address indexed next);

    error NotOwner();
    error InsufficientBalance();
    error InsufficientAllowance();
    error FaucetCooldown(uint256 availableAt);
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerChanged(address(0), owner_);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    function faucet() external {
        uint256 availableAt = lastFaucetAt[msg.sender] + FAUCET_COOLDOWN;
        if (lastFaucetAt[msg.sender] != 0 && block.timestamp < availableAt) {
            revert FaucetCooldown(availableAt);
        }
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Weekly refill. Drain is a score, not a resource that runs out.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function mintBatch(address[] calldata to, uint256 amount) external onlyOwner {
        for (uint256 i = 0; i < to.length; ++i) {
            _mint(to[i], amount);
        }
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _mint(address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
