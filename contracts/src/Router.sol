// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IGateway} from "./IGateway.sol";
import {CertData, Protocol} from "./lib/Protocol.sol";
import {RLPTx} from "./lib/RLPTx.sol";

interface IERC20Router {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IEscrowView {
    function token() external view returns (address);
    function gateway() external view returns (address);
}

/// @notice Holds what one source rollup has withdrawn towards one destination,
///         until the router passes it on. Deployed by the router with CREATE2,
///         so its address is known before it exists and a user can sign it.
contract Mailbox {
    address public immutable router;

    constructor() {
        router = msg.sender;
    }

    function pull(IERC20Router token, uint256 amount) external {
        require(msg.sender == router, "only the router");
        require(token.transfer(router, amount), "transfer failed");
    }
}

/// @title Router - moves CRS from one group's rollup to another's. Course
///        infrastructure, deployed once on the course L1; no student writes it.
///
/// @notice A cross-rollup transfer is an ordinary withdrawal on the source
///         rollup whose L1 recipient is `mailboxOf(source, destination)`, then
///         `forward`, which anyone may call once the source batch is final.
///         The router claims the withdrawal into that mailbox and deposits it on
///         the destination rollup for the same address: an L1 key is the L2 key.
///
///         The destination is inside the user's SIGNED order, as its recipient,
///         so nobody can redirect a transfer. And nothing new about finality is
///         decided here: the source Gateway's `withdraw` already refuses a batch
///         that is not final.
///
/// @dev Permissions are hierarchical. The owner, the course's master key, names
///      one operator per l2Id and can replace or revoke it, say after a leaked
///      key, which also clears what that operator registered (`setOperator`).
///      The operator, a group's key, registers that group's Gateway, and
///      registers it again after every redeploy. Deposits always go to the
///      current Gateway; `forward` accepts any Gateway registered for the
///      source under its current operator, so a withdrawal made through a
///      Gateway since replaced still arrives.
///
///      What a malicious operator can cost, given every Gateway is student code:
///
///      - Only its own rollup's money. Funds rest in a mailbox per (source,
///        destination) pair, and only a Gateway of the source pays into the
///        source's mailboxes, out of that Gateway's own escrow. `forward` passes
///        on exactly what it measured arriving in the mailbox during the call,
///        and the router holds nothing between calls. So an operator that
///        registers a contract that is not a Gateway, or another group's
///        Gateway, can at worst move money out of mailboxes whose source is its
///        own l2Id: money its own users withdrew.
///      - The one path that does not measure arrival is a withdrawal somebody
///        already claimed by calling the source Gateway directly, which pays the
///        mailbox without forwarding. `forward` then accepts the frozen
///        `AlreadyWithdrawn` revert as proof and forwards from what the mailbox
///        holds. A fake Gateway can fake that revert, but the mailbox it can
///        drain is still one of its own l2Id's.
///      - Another group's Gateway registered under the wrong id is refused,
///        because its chain id names its own rollup. A contract that lies about
///        its chain id is the case above.
///      - Users bridging INTO a rollup trust that rollup's operator, as they
///        trust its committee: a malicious current Gateway or escrow can keep
///        what is deposited into it. That is choosing a rollup, not something a
///        router can fix.
contract Router {
    struct Rollup {
        address gateway;
        address escrow;
    }

    IERC20Router public immutable token;
    address public immutable owner;

    /// One operator per rollup, the key allowed to register its Gateway.
    mapping(uint32 => address) public operatorOf;
    /// The Gateway deposits go to.
    mapping(uint32 => Rollup) public current;
    /// Bumped every time the owner names, replaces or revokes an operator.
    mapping(uint32 => uint64) public era;
    /// The era each Gateway was registered in. Only Gateways of the current
    /// era are accepted as a source; see `setOperator`.
    mapping(uint32 => mapping(address => uint64)) public gatewayEra;
    /// Withdrawals this router has forwarded or returned, by source rollup,
    /// source Gateway, sender and sequence. The Gateway is part of the key
    /// because a redeployed rollup starts every account at sequence 0 again. The source Gateway's own nullifier stops a second payout; this
    /// stops a second forward of a payout claimed directly.
    mapping(bytes32 => bool) public done;

    bool private entered;

    event OperatorSet(uint32 indexed l2Id, address operator);
    event GatewayRegistered(uint32 indexed l2Id, address gateway, address escrow);
    event Forwarded(
        uint32 indexed fromL2, uint32 indexed toL2, address indexed sender, uint64 sequence, uint128 amount
    );
    /// Paid out on L1 instead: the destination is not registered and the
    /// sender asked, or the destination refused the deposit. `amount` is what
    /// was actually paid back, less than the order's if a destination kept part.
    event Returned(
        uint32 indexed fromL2, uint32 indexed toL2, address indexed sender, uint64 sequence, uint128 amount
    );

    error NotOwner();
    error NotOperator();
    error WrongChainId();
    error BadEscrow();
    error UnknownSourceGateway();
    error NotAWithdrawalToThisMailbox();
    error AlreadyForwarded();
    error PaidWrongAmount();
    error DestinationNotRegistered();
    error Reentered();
    error OperatorUnchanged();
    error NotAuthenticated();

    constructor(address token_, address owner_) {
        token = IERC20Router(token_);
        owner = owner_;
    }

    modifier nonReentrant() {
        // Every Gateway is student code and every call into one is external.
        if (entered) revert Reentered();
        entered = true;
        _;
        entered = false;
    }

    // ------------------------------------------------------------ permissions

    /// @notice Name, replace or revoke (zero) the operator of one rollup.
    ///
    /// @dev Replacing or revoking is how the course rescues a group whose key
    ///      leaked, so it also clears the rollup's current Gateway and strikes
    ///      every Gateway registered under the operator it replaces: a leaked
    ///      key may already have registered an attacker's contract, and the
    ///      owner cannot tell which registrations came after the leak. Cleared,
    ///      a forward INTO the rollup waits (see `forward`) rather than
    ///      depositing into whatever the leaked key registered; struck, a
    ///      forward FROM it no longer accepts that contract as a source.
    ///
    ///      Striking all of them, legitimate ones included, is the simplest
    ///      rule that is sound without knowing when the leak happened. The new
    ///      operator re-registers every earlier Gateway it vouches for, current
    ///      one last, and withdrawals through them forward again. Nothing is
    ///      lost meanwhile: a forward that is refused spends no nullifier, and
    ///      a withdrawal claimed directly waits in its mailbox.
    ///
    ///      Naming the operator a rollup already has is refused rather than
    ///      done, because it would strike that group's Gateways for nothing. A
    ///      rescue always changes the key; striking without a new key is a
    ///      revoke followed by naming the key again.
    function setOperator(uint32 l2Id, address operator) external {
        if (msg.sender != owner) revert NotOwner();
        if (operator == operatorOf[l2Id]) revert OperatorUnchanged();
        operatorOf[l2Id] = operator;
        era[l2Id] += 1;
        delete current[l2Id];
        emit OperatorSet(l2Id, operator);
    }

    /// @notice Whether `gateway` is accepted as a source for `l2Id` now.
    function wasGateway(uint32 l2Id, address gateway) public view returns (bool) {
        uint64 e = gatewayEra[l2Id][gateway];
        return e != 0 && e == era[l2Id];
    }

    /// @notice Make `gateway` the current Gateway of `l2Id`. Called again after
    ///         every redeploy; the previous one stays forwardable.
    function registerGateway(uint32 l2Id, address gateway, address escrow) external {
        if (msg.sender != operatorOf[l2Id] || msg.sender == address(0)) revert NotOperator();
        // Not a proof that this is a real Gateway, which no check here could
        // be. It catches registering another group's rollup by mistake, and a
        // contract that lies about it can only cost its own rollup's money.
        if (IGateway(gateway).chainId() != Protocol.chainIdForL2(l2Id)) revert WrongChainId();
        if (IEscrowView(escrow).gateway() != gateway || IEscrowView(escrow).token() != address(token)) {
            revert BadEscrow();
        }
        current[l2Id] = Rollup(gateway, escrow);
        gatewayEra[l2Id][gateway] = era[l2Id];
        emit GatewayRegistered(l2Id, gateway, escrow);
    }

    // ------------------------------------------------------------- mailboxes

    /// @notice The L1 recipient a user puts in a withdrawal to send it from
    ///         rollup `fromL2` to rollup `toL2`. Valid before it is deployed.
    function mailboxOf(uint32 fromL2, uint32 toL2) public view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff), address(this), _salt(fromL2, toL2), keccak256(type(Mailbox).creationCode)
            )
        );
        return address(uint160(uint256(h)));
    }

    function _salt(uint32 fromL2, uint32 toL2) private pure returns (bytes32) {
        return bytes32((uint256(fromL2) << 32) | uint256(toL2));
    }

    function _mailbox(uint32 fromL2, uint32 toL2) private returns (Mailbox) {
        address a = mailboxOf(fromL2, toL2);
        if (a.code.length == 0) new Mailbox{salt: _salt(fromL2, toL2)}();
        return Mailbox(a);
    }

    // --------------------------------------------------------------- forward

    /// @notice Claim a withdrawal from `fromL2` into its mailbox and deposit it
    ///         on `toL2` for the same address. Anyone may call it.
    /// @param sourceGateway any Gateway ever registered for `fromL2`, the one
    ///        the withdrawal was posted to.
    /// @dev The other four arguments are the source Gateway's own `withdraw`
    ///      arguments, passed through unchanged.
    function forward(
        uint32 fromL2,
        uint32 toL2,
        address sourceGateway,
        uint64 batchId,
        uint32 certIndex,
        bytes calldata certData,
        bytes32[] calldata stepRoots
    ) external nonReentrant {
        if (!wasGateway(fromL2, sourceGateway)) revert UnknownSourceGateway();
        Mailbox box = _mailbox(fromL2, toL2);

        RLPTx.Tx memory t = _order(sourceGateway, certData, certIndex);
        if (t.kind != RLPTx.Kind.Withdraw || t.recipient != address(box)) {
            revert NotAWithdrawalToThisMailbox();
        }

        bytes32 key = keccak256(abi.encode(fromL2, sourceGateway, t.sender, t.nonce));
        if (done[key]) revert AlreadyForwarded();
        done[key] = true;

        Rollup memory dst = current[toL2];
        // Waiting is the default for an unregistered destination: the group may
        // still register. Only the sender may give up and take it on L1.
        if (dst.gateway == address(0) && msg.sender != t.sender) revert DestinationNotRegistered();

        _claim(IGateway(sourceGateway), box, t.value, batchId, certIndex, certData, stepRoots);
        uint256 held = token.balanceOf(address(this));
        box.pull(token, t.value);
        _deliver(fromL2, toL2, dst, t, held);
    }

    /// @dev External, so RLPTx can slice the order as real calldata.
    function decodeOrder(bytes calldata raw, uint256 chainId) external pure returns (RLPTx.Tx memory) {
        return RLPTx.decode(raw, chainId);
    }

    function _order(address gateway, bytes calldata certData, uint32 certIndex)
        private
        view
        returns (RLPTx.Tx memory)
    {
        CertData.Cert[] memory certs = CertData.decode(certData);
        if (certIndex >= certs.length) revert NotAWithdrawalToThisMailbox();
        return this.decodeOrder(certs[certIndex].order, IGateway(gateway).chainId());
    }

    /// Get the withdrawal into the mailbox, and be sure it is there.
    function _claim(
        IGateway gateway,
        Mailbox box,
        uint128 value,
        uint64 batchId,
        uint32 certIndex,
        bytes calldata certData,
        bytes32[] calldata stepRoots
    ) private {
        uint256 before = token.balanceOf(address(box));
        try gateway.withdraw(batchId, certIndex, certData, stepRoots) {
            // Exactly what the order says, measured. A Gateway that pays less,
            // or pays from somewhere else into another mailbox, is refused.
            if (token.balanceOf(address(box)) != before + value) revert PaidWrongAmount();
        } catch (bytes memory why) {
            // Somebody called `withdraw` directly, which pays this mailbox and
            // forwards nothing, and the frozen error says so.
            if (why.length < 4 || bytes4(why) != IGateway.AlreadyWithdrawn.selector) {
                assembly {
                    revert(add(why, 32), mload(why))
                }
            }
            // But the error alone is not proof that THIS order was paid. A
            // correct Gateway may check its nullifier before it authenticates
            // the order, and then a never-posted order at a sequence its sender
            // already used, with somebody else's amount, earns the same revert
            // and would drain a parked withdrawal. So the order must be shown
            // to be posted, final and applied, exactly as `withdraw` would.
            if (!_authenticated(gateway, batchId, certIndex, certData, stepRoots)) revert NotAuthenticated();
            if (before < value) revert PaidWrongAmount();
        }
    }

    /// @dev The reference `withdraw`'s checks, through the frozen accessors.
    ///      Both commitments are frozen in IGateway (`certDataHash` and
    ///      `stepRootsHash`), so this recomputes them exactly as every Gateway
    ///      must. One that hashes otherwise is never authenticated here, which
    ///      fails closed.
    function _authenticated(
        IGateway gateway,
        uint64 batchId,
        uint32 certIndex,
        bytes calldata certData,
        bytes32[] calldata stepRoots
    ) private view returns (bool) {
        if (!gateway.isFinal(batchId)) return false;
        Posted memory b = _posted(gateway, batchId);
        if (b.invalidated || keccak256(certData) != b.certHash || certIndex >= b.certCount) return false;
        if (keccak256(abi.encodePacked(stepRoots)) != b.rootsHash) return false;
        uint256 step = uint256(b.depositCount) + certIndex;
        if (step >= stepRoots.length) return false;
        bytes32 before = step == 0 ? b.pre : stepRoots[step - 1];
        return stepRoots[step] != before;
    }

    struct Posted {
        bytes32 pre;
        bytes32 certHash;
        bytes32 rootsHash;
        uint64 certCount;
        uint64 depositCount;
        bool invalidated;
    }

    /// The fields of a batch `_authenticated` needs, read in their own frame
    /// because the whole tuple does not fit on the stack beside the rest.
    function _posted(IGateway gateway, uint64 batchId) private view returns (Posted memory p) {
        (p.pre,, p.certHash, p.rootsHash,, p.certCount, p.depositCount,,,, p.invalidated) =
            gateway.batches(batchId);
    }

    /// Deposit on the destination, or hand it back on L1 if there is none or it
    /// will not take it. Nothing stays in the router either way.
    /// @param held what the router held before this forward pulled its money,
    ///        which is never paid out here.
    function _deliver(uint32 fromL2, uint32 toL2, Rollup memory dst, RLPTx.Tx memory t, uint256 held)
        private
    {
        if (dst.gateway != address(0)) {
            uint256 before = token.balanceOf(address(this));
            require(token.approve(dst.escrow, t.value), "approve failed");
            try IGateway(dst.gateway).deposit(t.sender, t.value) {
                if (token.balanceOf(address(this)) + t.value == before) {
                    emit Forwarded(fromL2, toL2, t.sender, t.nonce, t.value);
                    return;
                }
            } catch {}
            require(token.approve(dst.escrow, 0), "approve failed");
        }
        // Only what this forward brought in and is still here: all of it,
        // unless a destination took part of it without reverting.
        uint256 left = token.balanceOf(address(this));
        uint256 back = left > held ? left - held : 0;
        if (back > t.value) back = t.value;
        if (back > 0) require(token.transfer(t.sender, back), "transfer failed");
        emit Returned(fromL2, toL2, t.sender, t.nonce, uint128(back));
    }
}
