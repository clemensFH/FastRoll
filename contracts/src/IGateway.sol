// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IGateway - the frozen L1 surface of one FastPay L2.
///
/// @notice This interface is GIVEN and must not be edited. Your Gateway must
///         declare `contract Gateway is IGateway`, which makes the compiler
///         enforce the surface rather than leaving it to a task description
///         nobody re-reads.
///
///         Everything here is depended on from outside your code: the grader
///         calls these functions, reads these events, and matches these errors.
///         Reasons and reward semantics are in the spec, not here.
///
///         WHAT IS NOT HERE. The fraud proofs are not part of this interface,
///         and that is deliberate. Nothing outside your own prover ever calls
///         them, so their shape is yours: how many arguments, what witnesses,
///         one round or several, one function or five. Freezing them would have
///         handed over the answer to the only genuinely open design question in
///         Task 3, which is what evidence a proof needs.
///
///         Declare them on your own `Gateway` and generate bindings from that.
///         The grader watches what your prover reports and whether the L1 call
///         it made actually slashed somebody; it never encodes a proof itself.
///
///         The batch accessor below is part of the surface whether or not that
///         is convenient. `packages/common` decodes it positionally, field by
///         field, and the grader's tests read `tipPlusOne`, so an implementation
///         that lays a batch out differently is not interoperable. Saying so
///         here is better than leaving it to be discovered.
///
///         Everything else about your storage is yours.
interface IGateway {
    // -------------------------------------------------------------- events

    event BatchPosted(uint64 indexed batchId, bytes32 postStateRoot, uint64 certCount, address poster);
    event BatchInvalidated(uint64 indexed batchId, uint8 reason, address prover, uint256 reward);
    event Deposited(uint64 indexed index, address recipient, uint128 amount);
    event DepositsCredited(uint64 through);
    event Withdrawn(address indexed sender, uint64 sequence, address to, uint128 amount);
    event ValidatorSlashed(address indexed validator, uint8 reason, address prover, uint256 reward);

    // -------------------------------------------------------------- errors
    //
    // Only the ones a frozen function can raise. The proofs' own errors live
    // on your Gateway with the proofs, because nothing outside your code names
    // them: no TypeScript here matches a Gateway error, and the grader checks
    // that a proof SLASHED somebody rather than how it failed.
    //
    // These are matched by name. A revert carrying a different error for the
    // same condition is a failure, because a challenger cannot tell "your proof
    // is wrong" from "your Gateway is wrong" without them.

    // Each revert condition of a frozen function has exactly one of these,
    // and spec/SPEC.md Section 2 lists which, in the order the checks run.

    /// postBatch: `expectedPreStateRoot` is not `currentStateRoot()`.
    error StaleBase();
    /// postBatch: the caller is not in the current epoch's committee.
    error NotCommitteeMember();
    /// postBatch: `depositsThrough` is below `depositsCredited()` or above
    /// `depositCount()`.
    error BadDepositsThrough();
    /// postBatch: a certificate in the blob names an epoch other than the
    /// current one.
    error CertificateEpochMismatch();
    /// postBatch: no certificate and no deposit.
    error EmptyBatch();
    /// withdraw: the batch is live but still inside its challenge window.
    error WindowOpen();
    /// deposit: an amount of zero.
    error ZeroDeposit();
    /// deposit: the zero address as recipient.
    error ZeroRecipient();
    /// deposit: a reserved address, such as the withdraw precompile, as recipient.
    error ReservedRecipient();
    /// withdraw: this sender's withdrawal at this nonce was already paid out.
    error AlreadyWithdrawn();
    /// withdraw: the order's step left the root unchanged, so it never applied.
    error BadWithdrawalProof();
    /// withdraw: the order at that index is a transfer, not a withdrawal.
    error NotAWithdrawal();
    /// withdraw: the order at that index does not decode.
    error OrderDoesNotDecode();
    /// postBatch: the blob does not parse. withdraw: the blob is not the one
    /// the batch committed to.
    error BadCertData();
    /// postBatch: not one root per step, or the last is not the post-state
    /// root. withdraw: the roots are not the ones the batch committed to.
    error BadStepRoots();
    /// withdraw: the certificate index is past the batch's certificates.
    error NotAStepOfThisKind();
    /// withdraw: no batch with that id was ever posted.
    error UnknownBatch();
    /// withdraw: the batch was invalidated.
    error BatchInvalid();

    // ----------------------------------------------------------- accessors

    /// @notice The L2 chain id this Gateway accepts orders for, 90000 + l2Id.
    function chainId() external view returns (uint256);

    /// @notice The root the next batch must build on. Before any batch, the
    ///         root of an all-empty tree, which is NOT zero.
    function currentStateRoot() external view returns (bytes32);

    function batchCount() external view returns (uint256);
    function depositCount() external view returns (uint256);

    /// @notice How many queued deposits have been credited by a posted batch.
    function depositsCredited() external view returns (uint64);

    /// @notice One past the index of the batch at the tip, so zero means
    ///         nothing has been posted and no sentinel is needed.
    function tipPlusOne() external view returns (uint64);

    /// @notice A posted batch, field by field.
    /// @dev The field ORDER is frozen, not just the names: `packages/common`
    ///      decodes this positionally. A `Batch[] public batches` with these
    ///      fields in this order generates exactly this getter.
    ///      The two commitments are frozen too, because the course router
    ///      checks a withdrawal against them: `certDataHash` is
    ///      `keccak256(certData)` and `stepRootsHash` is
    ///      `keccak256(abi.encodePacked(stepRoots))`, both over exactly what
    ///      `postBatch` was given.
    function batches(uint256 id)
        external
        view
        returns (
            bytes32 preStateRoot,
            bytes32 postStateRoot,
            bytes32 certDataHash,
            bytes32 stepRootsHash,
            uint64 epoch,
            uint64 certCount,
            uint64 depositCount,
            uint64 depositsFrom,
            address poster,
            uint64 postedAt,
            bool invalidated
        );

    /// @notice True once a batch can no longer be challenged and its state may
    ///         be withdrawn against.
    function isFinal(uint64 batchId) external view returns (bool);

    /// @notice Whether this validator has been slashed. Permanent.
    function slashed(address validator) external view returns (bool);

    /// @notice L1 blocks a batch stays challengeable. Zero means Task 2
    ///         semantics: the committee is trusted and no batch can be
    ///         challenged. The proofs against a validator's own votes have no
    ///         window, so they work whatever this is.
    function challengeWindow() external view returns (uint64);

    // ------------------------------------------------------------- bridging

    /// @notice Bridge CRS from L1 into the L2. Credited by a later batch, in
    ///         order, unconditionally.
    function deposit(address recipient, uint128 amount) external;

    /// @notice Pay out a withdrawal, reading the recipient and the amount from
    ///         the order inside the batch's certificate blob.
    /// @dev The caller supplies neither, on purpose. See the spec.
    function withdraw(
        uint64 batchId,
        uint32 certIndex,
        bytes calldata certData,
        bytes32[] calldata stepRoots
    ) external;

    // -------------------------------------------------------------- posting

    /// @notice Post certificates and the per-step roots they produce.
    /// @param expectedPreStateRoot the root this batch was built on, which
    ///        must still be `currentStateRoot()` when it lands, or the call
    ///        reverts with `StaleBase` before anything else is checked.
    /// @return batchId the index of the batch just posted
    function postBatch(
        bytes calldata certData,
        bytes32[] calldata stepRoots,
        bytes32 postStateRoot,
        uint64 depositsThrough,
        bytes32 expectedPreStateRoot
    ) external returns (uint64 batchId);

    // --------------------------------------------------------------- proofs
    //
    // Deliberately absent. See the note at the top: the proofs are yours.
    //
    // `slashed(address)` above IS here, because the grader reads it to check
    // that a proof had an effect, and `ValidatorSlashed` is here for the same
    // reason. What a proof takes to get there is not anybody else's business.
    //
    // There is also deliberately nothing anywhere for an equivocating SENDER:
    // that strands the sender until the next epoch boundary and harms nobody,
    // so there is nothing to prove.
}
