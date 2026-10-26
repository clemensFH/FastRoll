// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CertData, Protocol} from "./lib/Protocol.sol";
import {MerkleLib} from "./lib/MerkleLib.sol";
import {RLPTx} from "./lib/RLPTx.sol";
import {Escrow} from "./Escrow.sol";
import {Registry} from "./Registry.sol";
import {IGateway} from "./IGateway.sol";

/// @title Gateway - the L1 anchor for one FastPay L2.
///
/// @notice A validator posts certificates and a claimed new state root. L1
///         stores both and verifies almost nothing. That is what makes Task 3
///         exist: if L1 verified five signatures per certificate on every post
///         there would be no fraud to prove, only transactions that revert, and
///         every honest batch would pay for fraud that almost never happens.
///
///         Four proofs, none needing bisection:
///
///           poster    a certificate that never had a quorum behind it
///           poster    a step root that does not follow from replaying the step,
///                     a deposit step or a certificate step, so four proofs
///                     cover the five `kind`s of spec/SPEC.md Section 3
///           validator signed two different orders at one sequence
///           validator signed an order the finalized state could not afford
///
///         There is deliberately nothing here for an equivocating SENDER.
///         Signing two orders at one sequence strands that sender until the
///         next epoch boundary and harms nobody: a certificate is the payment,
///         so a half-collected one deceives no counterparty, and two quorums of
///         five out of seven always share three validators each holding one
///         pending order per sequence, so no double spend can form.
///
///         What is frozen is what IGateway declares, and the constructor's
///         signature, which the deploy script and the grader's tests call: the
///         batch accessor's field order, `deposit`, `postBatch`, `withdraw`,
///         `slashed`, the events and those errors. Everything to do with the
///         FRAUD PROOFS is yours, including their witness type and their own
///         errors, because nothing outside this contract encodes them.
contract Gateway is IGateway {
    Registry public immutable registry;
    Escrow public immutable escrow;
    uint32 public immutable l2Id;
    uint256 public immutable chainId;
    bytes32 public immutable genesisRoot;

    struct Batch {
        bytes32 preStateRoot;
        bytes32 postStateRoot;
        bytes32 certDataHash;
        /// keccak256 over the published per-step roots.
        bytes32 stepRootsHash;
        uint64 epoch;
        uint64 certCount;
        uint64 depositCount;
        /// First deposit index this batch credits. Stored rather than derived,
        /// because depositsCredited moves on as later batches land.
        uint64 depositsFrom;
        address poster;
        uint64 postedAt;
        bool invalidated;
    }

    Batch[] public batches;
    /// One past the id of the valid tip. Zero means nothing posted yet.
    uint64 public tipPlusOne;

    /// L1 blocks a batch must survive before withdrawals against it pay out.
    /// Zero reproduces Task 2 semantics, where the committee is simply trusted.
    uint64 public challengeWindow;

    /// Paper's per-account withdraw log, keyed by (sender, sequence).
    mapping(bytes32 => bool) public withdrawn;
    /// One past the epoch of the latest invalidation, or zero if there has
    /// been none. A rollback can lower balances and rewind sequences, so a
    /// vote for that epoch or an earlier one may have been cast against a
    /// history that no longer exists, and no unfunded-signature proof may
    /// judge it.
    uint64 public invalidatedEpochPlusOne;

    /// Validators already slashed, so one misbehaviour pays out once.
    mapping(address => bool) public slashed;

    /// Deposits waiting to be credited into L2 state.
    struct Deposit {
        address recipient;
        uint128 amount;
        uint64 l1Block;
    }
    Deposit[] public deposits;
    uint64 public depositsCredited;

    event ChallengeWindowChanged(uint64 blocks_);

    error NotOwner();

    address public owner;

    constructor(
        address registry_,
        address escrow_,
        uint32 l2Id_,
        bytes32 genesisRoot_,
        uint64 challengeWindow_,
        address owner_
    ) {
        registry = Registry(payable(registry_));
        escrow = Escrow(escrow_);
        l2Id = l2Id_;
        chainId = Protocol.chainIdForL2(l2Id_);
        genesisRoot = genesisRoot_;
        challengeWindow = challengeWindow_;
        owner = owner_;
    }

    function setChallengeWindow(uint64 blocks_) external {
        if (msg.sender != owner) revert NotOwner();
        challengeWindow = blocks_;
        emit ChallengeWindowChanged(blocks_);
    }

    // --------------------------------------------------------------- views

    function currentStateRoot() public view returns (bytes32) {
        // The root of the last LIVE batch, or the genesis root if there is none.
        // An invalidation walks the tip back, so this must not return a root from
        // the discarded region: no honest replayer will ever reproduce it.
        // TODO(task-2): currentStateRoot
        revert("TODO(task-2): currentStateRoot");
    }

    function batchCount() external view returns (uint256) {
        // Every batch ever posted, invalidated ones included.
        // TODO(task-2): batchCount
        revert("TODO(task-2): batchCount");
    }

    function depositCount() external view returns (uint256) {
        // Deposits ever made, not deposits credited.
        // TODO(task-2): depositCount
        revert("TODO(task-2): depositCount");
    }

    function isFinal(uint64 batchId) public view returns (bool) {
        // Past its challenge window, so no longer challengeable. A window of zero
        // is Task 2 semantics, where a batch is final the moment it is posted and
        // there are no fraud proofs at all.
        // TODO(task-2): isFinal
        revert("TODO(task-2): isFinal");
    }

    // ---------------------------------------------------------- deposits

    /// @notice Bridge CRS from L1 into the L2.
    /// @dev Whatever is checked has to be checked HERE and not in the state
    ///      transition. Validators must consume deposits in order, so a deposit
    ///      that could fail would trap them between refusing it and producing a
    ///      state everyone else disagrees with. Reverting here costs the
    ///      depositor a failed transaction and nothing more.
    ///
    ///      A zero deposit is refused because it produces a batch step that
    ///      changes no root while still costing every replayer the work.
    function deposit(address recipient, uint128 amount) external {
        // Bridge in. Pull the tokens into escrow, queue the credit, and emit.
        // The L2 credit happens when a batch says it did: nothing here can move
        // L2 state, because only a posted batch does that. The checks and their
        // order are in spec/SPEC.md Section 2, "Bridging".
        // TODO(task-2): deposit
        revert("TODO(task-2): deposit");
    }

    // ------------------------------------------------------------ posting

    /// @notice Post certificates and the state root they produce.
    ///
    /// @dev What is checked here is deliberately thin. The batch must be built
    ///      on the current root, and the poster must be in the current epoch's
    ///      committee. Everything else is left to the fraud proofs,
    ///      because verifying five signatures per certificate on the happy path
    ///      would cost more than the rollup saves.
    ///
    ///      `depositsThrough` lets a poster declare how many pending deposits
    ///      the new root includes, so the replay proof knows what to apply.
    /// @param stepRoots the state root after each individual step, deposits
    ///        first then certificates in blob order. Length must be
    ///        depositCount + certCount, and the last entry must equal
    ///        postStateRoot.
    ///
    /// @dev One root per step is what keeps the transition proof single-round.
    ///      Publishing only the final root would force a challenger to replay
    ///      the whole batch on-chain, carrying an account witness for every
    ///      account it touched. With per-step roots the proof is two roots, one
    ///      item and at most two witnesses, and it costs 32 bytes of calldata
    ///      per step to get there.
    function postBatch(
        bytes calldata certData,
        bytes32[] calldata stepRoots,
        bytes32 postStateRoot,
        uint64 depositsThrough,
        bytes32 expectedPreStateRoot
    ) external returns (uint64) {
        // Accept a batch. spec/SPEC.md Section 2, "Posting", lists the checks
        // and the error for each, in the order they must run, and, more
        // importantly, says what this must NOT check.
        //
        // It verifies no signature, no balance, and recomputes no root. A poster
        // can claim any post-state root it likes and this will succeed. That is
        // the whole point of an optimistic rollup and the reason Task 3 exists.
        //
        // preStateRoot is stored from currentStateRoot(), not from the caller:
        // the caller's expectedPreStateRoot is only checked against it.
        //
        // Commit the epoch's committee before checking membership: the first
        // batch of an epoch pins it, which is what makes it one storage slot to
        // prove later.
        // The base first. Two honest posters building on the same root race,
        // and the second must fail cleanly rather than land a batch whose steps
        // start from a root that is no longer the tip.
        // TODO(task-2): postBatch
        revert("TODO(task-2): postBatch");
    }

    // --------------------------------------------------------- withdrawal

    /// @notice Withdraw a withdrawal, proved against the batch that applied it.
    ///
    /// @dev This used to take `to` and `amount` as free parameters and prove
    ///      only that the sender's sequence had advanced. That was an escrow
    ///      drain: an ordinary transfer advances a sequence just as well as a
    ///      withdrawal does, so anybody could take the public witness for a 10
    ///      CRS withdrawal and pay themselves the entire escrow. The withdraw log
    ///      does not save it, because the log only stops the same
    ///      (sender, sequence) being claimed twice and says nothing at all
    ///      about the amount or the recipient.
    ///
    ///      So the withdrawal is read out of the certificate blob instead, and
    ///      the recipient and the amount come from the order the sender signed.
    ///      Nothing is left for a caller to choose.
    ///
    ///      Presence in the blob is not enough on its own. An order the
    ///      transition rejected is a complete no-op, and a sender who
    ///      equivocated could have a second certificate at the same sequence in
    ///      a later batch doing nothing. So the step root has to have MOVED,
    ///      which is what separates an order that was applied from one that was
    ///      merely posted.
    function withdraw(
        uint64 batchId,
        uint32 certIndex,
        bytes calldata certData,
        bytes32[] calldata stepRoots
    ) external {
        // Bridge out, against a batch that is final. The ten checks and their
        // order are in spec/SPEC.md Section 2, "Bridging".
        //
        // The recipient and the amount are NOT parameters. Read them from the
        // order inside the blob. An earlier version took them from the caller and
        // proved only that the sender's sequence had advanced, which an ordinary
        // transfer does just as well: that was an escrow drain, and the public
        // witness for a 10 CRS withdrawal paid an attacker the entire escrow.
        //
        // Presence in the blob is not enough either. An order the transition
        // rejected is a no-op, and a no-op step leaves the root unchanged, so the
        // step root has to have MOVED.
        // TODO(task-2): withdraw
        revert("TODO(task-2): withdraw");
    }

    // ---------------------------------------------------------- the proofs
    //
    // TODO(task-3): the fraud proofs. IGateway does not declare them, because
    // nothing outside this contract calls them: how many functions there are,
    // what each takes, which witnesses and which errors are yours.
    // spec/SPEC.md Section 3 says what must be provable and what must not be.
    // Every slash sets `slashed` and emits ValidatorSlashed; `_invalidate`
    // below does both for a poster. Run `pnpm abis` after declaring them.


    function _checkStepRoots(Batch storage b, bytes32[] calldata stepRoots) private view {
        if (keccak256(abi.encodePacked(stepRoots)) != b.stepRootsHash) revert BadStepRoots();
    }

    function _depositIndex(Batch storage b, uint32 stepIndex) private view returns (uint256) {
        return uint256(b.depositsFrom) + stepIndex;
    }

    /// @notice Decode a certificate blob. External so `postBatch` can wrap it
    ///         in try/catch; `pure`, so it reads nothing and changes nothing.
    function certsOf(bytes calldata blob) external pure returns (CertData.Cert[] memory) {
        return CertData.decode(blob);
    }

    /// @dev No try/catch here. Every caller has already checked the blob
    ///      against a stored `certDataHash`, and a blob that does not decode
    ///      could never have been posted, so a revert is unreachable rather
    ///      than unhandled.
    function _certAt(bytes calldata certData, uint32 index) private pure returns (CertData.Cert memory) {
        CertData.Cert[] memory certs = CertData.decode(certData);
        if (index >= certs.length) revert NotAStepOfThisKind();
        return certs[index];
    }



    // ---------------------------------------------------------- internals




    /// @dev Invalidating a batch discards every batch after it, since they all
    ///      built on a bad root. The loop is bounded by how many unfinalized
    ///      batches exist, and that is bounded by the challenge window.
    function _invalidate(uint64 batchId, uint8 reason) private {
        uint256 n = batches.length;
        for (uint256 i = batchId; i < n; ++i) {
            batches[i].invalidated = true;
        }

        // Give back the deposits this batch and its successors credited.
        // Without this the CRS stays in escrow with no L2 account behind it,
        // postBatch forbids any future batch from re-crediting it, and every
        // honest replayer counts deposits from a different starting point than
        // the contract does, which forks the replay permanently.
        depositsCredited = batches[batchId].depositsFrom;

        // Walk back past anything already invalidated. A later challenge can
        // name an earlier batch, and leaving the tip pointing into the
        // invalidated region makes currentStateRoot return a discarded root
        // that no honest observer will ever reproduce.
        uint64 tip = batchId;
        while (tip > 0 && batches[tip - 1].invalidated) {
            --tip;
        }
        tipPlusOne = tip;
        invalidatedEpochPlusOne = registry.currentEpoch() + 1;
        address poster = batches[batchId].poster;
        uint256 reward = 0;
        if (!slashed[poster]) {
            slashed[poster] = true;
            reward = registry.slash(poster, msg.sender, reason);
            // Every slash says so, a poster's included: the event is how anyone
            // outside sees that a proof worked.
            emit ValidatorSlashed(poster, reason, msg.sender, reward);
        }
        emit BatchInvalidated(batchId, reason, msg.sender, reward);
    }

    /// @dev External so RLPTx's calldata slicing works on a real calldata region.
    function decodeOrder(bytes calldata raw) external view returns (RLPTx.Tx memory) {
        return RLPTx.decode(raw, chainId);
    }

    receive() external payable {}
}
