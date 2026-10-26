// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Protocol - shared FastPay constants and encodings. FROZEN.
/// @notice Mirrors packages/common/src/{constants,state,certificate,committee}.ts
///         and is pinned by spec/vectors and contracts/test/Conformance.t.sol.
library Protocol {
    // ------------------------------------------------------------- committee

    /// Paper's 3f+1 with a 2f+1 quorum. Seven validators means f = 2.
    uint256 internal constant COMMITTEE_SIZE = 7;
    uint256 internal constant MAX_FAULTY = 2;
    uint256 internal constant QUORUM = 5;

    /// Epoch e+1's committee is the top COMMITTEE_SIZE stakers snapshotted at
    /// the last L1 block of epoch e. A fixed interval is what makes "which set
    /// was current when this was signed" answerable at all.
    uint256 internal constant EPOCH_BLOCKS = 1000;

    /// Epochs a departing validator's stake stays locked. Must outlast the time
    /// in which a proof against its last epoch can still land: that epoch's
    /// certificates can be posted only within it, and the batches carrying them
    /// stay challengeable for the challenge window after.
    uint256 internal constant UNBONDING_EPOCHS = 3;

    // ------------------------------------------------------------- constants

    uint256 internal constant CHAIN_ID_BASE = 90000;
    uint256 internal constant GAS_PER_TX = 21000;

    address internal constant WITHDRAW_PRECOMPILE = 0x00000000000000000000000000000000000000fe;

    function chainIdForL2(uint32 l2Id) internal pure returns (uint256) {
        return CHAIN_ID_BASE + l2Id;
    }

    function isReserved(address a) internal pure returns (bool) {
        return a == address(0) || a == WITHDRAW_PRECOMPILE;
    }

    function epochOf(uint256 l1Block) internal pure returns (uint64) {
        return uint64(l1Block / EPOCH_BLOCKS);
    }

    /// First L1 block of an epoch.
    function epochStart(uint64 epoch) internal pure returns (uint256) {
        return uint256(epoch) * EPOCH_BLOCKS;
    }

    /// Block at which an epoch's committee was snapshotted, namely the last
    /// block of the previous epoch.
    function snapshotBlock(uint64 epoch) internal pure returns (uint256) {
        return epoch == 0 ? 0 : epochStart(epoch) - 1;
    }

    // ------------------------------------------------------------ state leaf

    /// @dev leaf = keccak256(abi.encodePacked(uint64 nextSequence, uint128 balance))
    function accountLeaf(uint64 nextSequence, uint128 balance) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(nextSequence, balance));
    }

    function emptyLeaf() internal pure returns (bytes32) {
        return accountLeaf(0, 0);
    }

    // ----------------------------------------------------------------- votes

    bytes32 internal constant VOTE_DOMAIN_HASH = keccak256("FASTPAY_VOTE_V1");

    /// @notice What a validator signs.
    /// @dev The epoch is inside the digest, so a vote cannot be carried across a
    ///      boundary. chainId is inside it, so a vote cannot be replayed on
    ///      another L2. Certificates expire at the boundary precisely because
    ///      old votes must become unusable.
    function voteDigest(uint256 chainId, uint64 epoch, bytes32 orderHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(VOTE_DOMAIN_HASH, chainId, epoch, orderHash));
    }

    /// @notice Identity of a certificate. Two certificates for the same order in
    ///         the same epoch are the same certificate, whichever signatures
    ///         happened to be gathered.
    function certificateId(uint64 epoch, bytes32 orderHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(epoch, orderHash));
    }

    /// @notice Key preventing a withdrawal being withdrawn twice, matching the
    ///         paper's per-account withdraw log.
    function withdrawalKey(address sender, uint64 sequence) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(sender, sequence));
    }
}

/// @title CertData - decoder for the posted certificate blob. FROZEN.
/// @notice One ABI encoded array, and `decode` below is the whole of it:
///
///     (uint64 epoch, bytes order, (bytes32 r, bytes32 s, uint8 v)[] signatures)[]
///
///         A blob that does not decode is rejected by `postBatch` rather than
///         stored for anyone to challenge, so it is NOT something a poster is
///         slashed for: the proof that used to do that was deleted, because it
///         had no true positives left.
library CertData {
    error TooManySignatures();

    struct Signature {
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    struct Cert {
        uint64 epoch;
        bytes order;
        Signature[] signatures;
    }

    /**
     * @notice Decode a certificate blob.
     *
     * @dev This used to be seventy lines of offset arithmetic, in two
     *      near-identical parsers so that one of them could report a bad blob
     *      without reverting, plus a third copy of the same format in
     *      TypeScript that had to agree with both exactly.
     *
     *      `abi.decode` bounds-checks itself and hands back signatures already
     *      split into r, s and v. It reverts on a malformed blob, which is the
     *      same outcome the hand-written version reached by a longer road: a
     *      blob that does not parse is rejected outright rather than stored for
     *      somebody to challenge.
     *
     *      It costs 79% more calldata than the packed format did on a fifty
     *      certificate batch, nearly all of it ABI padding a one-byte `v` out
     *      to a 32-byte word. That is a real cost and a deliberate one:
     *      hand-optimising a teaching project's calldata in code that is GIVEN
     *      removes the exercise, and how to make it cheaper is a question the
     *      task asks instead.
     */
    function decode(bytes calldata blob) internal pure returns (Cert[] memory certs) {
        // A batch that only credits deposits carries no certificates, and its
        // blob may be empty. An empty blob is not a valid ABI encoding of an
        // empty array, so accept it here as no certificates rather than making
        // every deposit-only batch pay 64 bytes to encode nothing. `postBatch`
        // counts the decoded certificates, so both forms mean the same.
        if (blob.length == 0) return new Cert[](0);
        certs = abi.decode(blob, (Cert[]));
        // The one rule the encoding cannot express. A certificate carrying more
        // signatures than there are committee seats has a duplicate in it, so
        // bounding this here keeps every caller's loop bounded too.
        for (uint256 i = 0; i < certs.length; ++i) {
            if (certs[i].signatures.length > Protocol.COMMITTEE_SIZE) revert TooManySignatures();
        }
    }
}
