// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Protocol} from "./lib/Protocol.sol";

/// @title Registry - staking, epochs, and each epoch's committee.
/// @notice Epoch e's committee is the top COMMITTEE_SIZE stakers as they stood
///         when e began. A stake change in epoch c takes effect from c+1, never
///         in c, so a committee is fixed for its whole epoch and "which set was
///         allowed to sign in this epoch" is a question with one answer.
///
///         Nothing has to happen at a boundary. Stakes change only through this
///         contract, so every change writes down, at once, the committee the
///         next epoch will have; a later change in the same epoch rewrites that
///         entry. The entries are therefore complete at every moment, and an
///         epoch with no change behind it costs nothing.
///
///         Stake is what the fraud proofs slash, so this contract is what
///         makes Task 3 possible at all.
contract Registry {
    struct Validator {
        uint256 stake;
        /// Epoch at which an exit was requested. Only meaningful when `exiting`.
        uint64 exitEpoch;
        bool registered;
        /// An explicit flag rather than `exitEpoch == 0` as a sentinel, because
        /// epoch 0 is a real epoch and an exit requested in it must still count.
        bool exiting;
    }

    address public owner;
    /// Set once, to the Gateway. Only it may slash.
    address public gateway;

    mapping(address => Validator) public validators;
    /// The live candidates: registered, not exiting, not slashed. Only these
    /// can be in a committee, so only these are scanned when one is computed,
    /// and there are at most MAX_CANDIDATES of them. A validator leaves the
    /// list when it requests an exit, is displaced, or is slashed; withdrawing
    /// afterwards only pays out.
    address[] public registered;
    /// address => index into `registered`, plus one, so zero means "not listed".
    mapping(address => uint256) private listed;
    /// A slashed key has spent its stake, and is not a validator again.
    mapping(address => bool) public slashed;

    /// One committee and the first epoch it holds for. An entry is written by a
    /// stake change, for the epoch after it, and only when the committee
    /// actually changes, so a committee is never stored twice and an idle
    /// stretch of epochs costs no writes at all.
    struct Version {
        uint64 fromEpoch;
        address[] members;
    }

    /// Strictly ascending by fromEpoch. The last entry may hold from the NEXT
    /// epoch, while changes are still being made in this one; it is never
    /// returned for, or pinned to, an epoch that has begun before its own.
    Version[] private versions;
    /// epoch => index into versions, plus one, so zero means "not pinned".
    /// Written by the first `commitEpoch` of an epoch, which `postBatch` calls:
    /// one slot, about 22k gas, rather than copying seven addresses at about
    /// 200k. It is what lets a light client prove an epoch's committee with a
    /// pointer and one entry instead of reproducing the search.
    mapping(uint64 => uint256) public epochVersion;

    uint256 public constant MIN_STAKE = 1 ether;
    /// Bounds the work of computing a committee: every committee lookup and
    /// every stake change scans the candidate list, so its length is what the
    /// gas of those calls depends on. Thirty-two is more than four committees'
    /// worth. When the list is full a newcomer must stake more than the
    /// weakest candidate, who then leaves as if it had requested an exit, its
    /// stake still bonded for UNBONDING_EPOCHS.
    uint256 public constant MAX_CANDIDATES = 32;

    event Registered(address indexed validator, uint256 stake);
    event StakeAdded(address indexed validator, uint256 stake);
    event ExitRequested(address indexed validator, uint64 atEpoch);
    event Withdrawn(address indexed validator, uint256 amount);
    /// A new committee entry, holding from `fromEpoch` until the next one.
    event CommitteeFixed(uint64 indexed fromEpoch, address[] committee);
    event Slashed(address indexed validator, uint256 amount, address indexed to, uint8 reason);

    error NotOwner();
    error NotGateway();
    error GatewayAlreadySet();
    error StakeTooSmall();
    error AlreadyRegistered();
    error NotRegistered();
    error EpochNotReached();
    error StillBonded();
    error NotExiting();
    error NothingToWithdraw();
    error SlashedKey();
    error NoValue();
    error StakeNotAboveWeakest();

    constructor(address owner_) {
        owner = owner_;
    }

    function setGateway(address gateway_) external {
        if (msg.sender != owner) revert NotOwner();
        if (gateway != address(0)) revert GatewayAlreadySet();
        gateway = gateway_;
    }

    // ----------------------------------------------------------- staking

    function register() external payable {
        if (msg.value < MIN_STAKE) revert StakeTooSmall();
        if (slashed[msg.sender]) revert SlashedKey();
        Validator storage v = validators[msg.sender];
        if (v.registered) revert AlreadyRegistered();
        if (registered.length == MAX_CANDIDATES) {
            address weakest = _weakest();
            if (msg.value <= validators[weakest].stake) revert StakeNotAboveWeakest();
            _unlist(weakest);
            Validator storage w = validators[weakest];
            w.exiting = true;
            w.exitEpoch = currentEpoch();
            emit ExitRequested(weakest, w.exitEpoch);
        }
        v.registered = true;
        v.stake = msg.value;
        _list(msg.sender);
        emit Registered(msg.sender, msg.value);
        _afterChange();
    }

    function addStake() external payable {
        if (msg.value == 0) revert NoValue();
        if (slashed[msg.sender]) revert SlashedKey();
        Validator storage v = validators[msg.sender];
        if (!v.registered) revert NotRegistered();
        v.stake += msg.value;
        emit StakeAdded(msg.sender, v.stake);
        _afterChange();
    }

    /// @notice Begin exiting. Stake stays slashable for UNBONDING_EPOCHS, which
    ///         is what stops a validator equivocating and then leaving before
    ///         anyone can prove it.
    function requestExit() external {
        Validator storage v = validators[msg.sender];
        if (!v.registered) revert NotRegistered();
        if (v.exiting) revert NotExiting();
        v.exiting = true;
        v.exitEpoch = currentEpoch();
        _unlist(msg.sender);
        emit ExitRequested(msg.sender, v.exitEpoch);
        _afterChange();
    }

    function withdrawStake() external {
        Validator storage v = validators[msg.sender];
        if (!v.registered) revert NotRegistered();
        if (!v.exiting) revert NotExiting();
        if (currentEpoch() <= v.exitEpoch + Protocol.UNBONDING_EPOCHS) revert StillBonded();
        uint256 amount = v.stake;
        if (amount == 0) revert NothingToWithdraw();
        // Not a committee change: an exiting validator left the candidate list,
        // and every committee, when its exit was requested.
        v.stake = 0;
        v.registered = false;
        v.exiting = false;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "withdraw failed");
    }

    // ------------------------------------------------------------ epochs

    function currentEpoch() public view returns (uint64) {
        return Protocol.epochOf(block.number);
    }

    /// @notice Pin the current epoch to its committee, and return it.
    ///         Permissionless and idempotent; `postBatch` calls it, so the first
    ///         batch of an epoch pays for the pin and every later one is free.
    function commitEpoch() external returns (address[] memory) {
        uint64 e = currentEpoch();
        if (epochVersion[e] == 0) {
            uint256 i = _inForce(e);
            if (i != 0) epochVersion[e] = i;
        }
        return committeeOf(e);
    }

    /// @notice The committee of any epoch that has begun, pinned or not.
    /// @dev Reverts for a future epoch: stakes may still move before it begins,
    ///      so any answer would be a guess that a later call could contradict.
    function committeeOf(uint64 epoch) public view returns (address[] memory) {
        if (epoch > currentEpoch()) revert EpochNotReached();
        uint256 pin = epochVersion[epoch];
        if (pin == 0) pin = _inForce(epoch);
        if (pin == 0) return new address[](0);
        return versions[pin - 1].members;
    }

    function isMember(uint64 epoch, address who) external view returns (bool) {
        address[] memory c = committeeOf(epoch);
        for (uint256 i = 0; i < c.length; ++i) {
            if (c[i] == who) return true;
        }
        return false;
    }

    /// @notice How many distinct committees there have been.
    function versionCount() external view returns (uint256) {
        return versions.length;
    }

    /// @dev The entry holding for `epoch`, as an index plus one, or zero when
    ///      there is none: the latest entry starting at or before it.
    function _inForce(uint64 epoch) internal view returns (uint256) {
        uint256 lo = 0;
        uint256 hi = versions.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (versions[mid].fromEpoch <= epoch) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /// @dev Every stake change calls this last: write down the committee the
    ///      next epoch will have, as the stakes now stand.
    ///
    ///      Written now rather than once the epoch is over, so that the entries
    ///      are complete at every moment: whatever happens or does not happen
    ///      afterwards, the committee of every epoch is an entry, and nothing is
    ///      left to be inferred from the live stakes. A second change in the
    ///      same epoch rewrites the same entry, and one that puts the committee
    ///      back as it was removes it again.
    function _afterChange() internal {
        uint64 next = currentEpoch() + 1;
        address[] memory top = _topStakers();
        uint256 n = versions.length;
        if (n > 0 && versions[n - 1].fromEpoch == next) {
            // This epoch has changed the stakes before. That entry is the
            // next epoch's and no epoch has begun under it, so it is free to
            // rewrite, and to drop when the committee is back to the previous one.
            bool asBefore = n >= 2 ? _same(versions[n - 2].members, top) : top.length == 0;
            if (asBefore) {
                versions.pop();
                // Said out loud, so an observer of the earlier event for this
                // epoch learns that it no longer stands.
                emit CommitteeFixed(next, top);
            } else {
                versions[n - 1].members = top;
                emit CommitteeFixed(next, top);
            }
            return;
        }
        // A change that did not move the top seven, such as a stake added
        // below the cut, needs no new entry.
        if (n > 0 ? _same(versions[n - 1].members, top) : top.length == 0) return;
        versions.push();
        Version storage v = versions[n];
        v.fromEpoch = next;
        v.members = top;
        emit CommitteeFixed(next, top);
    }

    function registeredCount() external view returns (uint256) {
        return registered.length;
    }

    function _list(address a) internal {
        registered.push(a);
        listed[a] = registered.length;
    }

    /// @dev Swap-remove, so leaving the list is constant work.
    function _unlist(address a) internal {
        uint256 i = listed[a];
        if (i == 0) return;
        address last = registered[registered.length - 1];
        registered[i - 1] = last;
        listed[last] = i;
        registered.pop();
        delete listed[a];
    }

    /// @dev The candidate a newcomer must outstake when the list is full: the
    ///      lowest stake, and among equal stakes the higher address, which is
    ///      the one the committee tie-break ranks last.
    function _weakest() internal view returns (address w) {
        uint256 low = type(uint256).max;
        for (uint256 i = 0; i < registered.length; ++i) {
            address a = registered[i];
            uint256 s = validators[a].stake;
            if (s < low || (s == low && a > w)) {
                low = s;
                w = a;
            }
        }
    }

    function _same(address[] storage a, address[] memory b) internal view returns (bool) {
        if (a.length != b.length) return false;
        for (uint256 i = 0; i < b.length; ++i) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    /// @dev Selection sort over the registered set. Ties break on the address,
    ///      ascending, so every observer computes the same committee from the
    ///      same stakes. Without a tie rule two honest nodes can disagree about
    ///      the committee and nothing works.
    function _topStakers() internal view returns (address[] memory) {
        uint256 n = registered.length;
        address[] memory addrs = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        uint256 live = 0;
        for (uint256 i = 0; i < n; ++i) {
            address a = registered[i];
            Validator storage v = validators[a];
            // The list holds only live candidates; checked again anyway, so a
            // committee can never contain an exiting or slashed key, or one
            // address twice.
            if (listed[a] != i + 1 || !v.registered || v.stake < MIN_STAKE || v.exiting || slashed[a]) {
                continue;
            }
            addrs[live] = a;
            amounts[live] = v.stake;
            ++live;
        }

        uint256 size = live < Protocol.COMMITTEE_SIZE ? live : Protocol.COMMITTEE_SIZE;
        address[] memory out = new address[](size);
        for (uint256 k = 0; k < size; ++k) {
            uint256 best = k;
            for (uint256 j = k + 1; j < live; ++j) {
                if (amounts[j] > amounts[best] || (amounts[j] == amounts[best] && addrs[j] < addrs[best])) {
                    best = j;
                }
            }
            (addrs[k], addrs[best]) = (addrs[best], addrs[k]);
            (amounts[k], amounts[best]) = (amounts[best], amounts[k]);
            out[k] = addrs[k];
        }
        return out;
    }

    // ---------------------------------------------------------- slashing

    /// @notice Slash a validator's whole stake and pay it to the prover.
    /// @dev Whole stake rather than a fraction, deliberately. Every
    ///      misbehaviour a proof slashes for is unambiguous and provable, so there is no honest
    ///      mistake to be lenient about, and a partial slash is just priced in.
    ///      The key is spent: it cannot register or add stake again, so the
    ///      Gateway's record that it was slashed stays the whole story.
    function slash(address validator, address to, uint8 reason) external returns (uint256) {
        if (msg.sender != gateway) revert NotGateway();
        Validator storage v = validators[validator];
        uint256 amount = v.stake;
        if (amount == 0) {
            slashed[validator] = true;
            return 0;
        }
        // The epoch it is slashed in keeps the committee it began with, slashed
        // key included; from the next epoch on the key is gone.
        slashed[validator] = true;
        v.stake = 0;
        _unlist(validator);
        emit Slashed(validator, amount, to, reason);
        _afterChange();
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "slash payout failed");
        return amount;
    }

    receive() external payable {}
}
