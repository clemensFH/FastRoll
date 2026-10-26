// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MerkleLib - sparse Merkle tree over the 20-byte address space. FROZEN.
/// @notice Must agree bit-for-bit with packages/common/src/merkle.ts. The
///         conformance vectors in spec/vectors enforce that in CI.
///
/// Depth is 160 because the key is the address and each bit selects a child.
/// Every possible address has a slot, which is what makes absence provable: an
/// unregistered account is an inclusion proof of EMPTY_LEAF.
///
/// Bit ordering is LSB-first. At level i we combine with the sibling using bit i
/// of the address, and a set bit means our node is the RIGHT child. MSB-first is
/// equally valid and completely incompatible, hence frozen.
library MerkleLib {
    uint256 internal constant TREE_DEPTH = 160;

    /// Protocol.emptyLeaf(), namely
    /// keccak256(abi.encodePacked(uint64(0), uint128(0))).
    /// A conformance test asserts these agree, so changing the account encoding
    /// without changing this fails loudly.
    bytes32 internal constant EMPTY_LEAF = 0x827b659bbda2a0bdecce2c91b8b68462545758f3eba2dbefef18e0daf84f5ccd;

    /// The root of a tree in which every account is empty, which is
    /// EMPTY_LEAF hashed with itself TREE_DEPTH times.
    ///
    /// A genesis root of bytes32(0) is NOT this, and the difference is quiet:
    /// posting and withdrawing never compare against the pre-state root, so only
    /// the transition proofs notice, and they notice by rejecting an honest
    /// challenger's witness for the very first batch.
    bytes32 internal constant EMPTY_ROOT = 0xeafd572a6ceab1553de795ab98ee4056a866a4ab447a38a6b23106bf03087c30;

    error BitmapClaimsMoreSiblings();
    error UnusedSiblings();

    /// @dev leaf = keccak256(abi.encodePacked(uint64 nextSequence, uint128 balance))
    function accountLeaf(uint64 nextSequence, uint128 balance) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(nextSequence, balance));
    }

    /// @notice Recompute the root implied by `leaf` sitting at `key`.
    /// @dev The empty-subtree constant E[i] is regenerated during the same walk,
    ///      one extra keccak per level. That is far cheaper than 160 SLOADs and
    ///      needs no constant array.
    /// @param bitmap Bit i set means siblings carries a real hash for level i;
    ///        clear means the sibling is E[i]. An all-ones bitmap with 160
    ///        siblings is the valid uncompressed encoding of the same proof.
    function computeRoot(address key, bytes32 leaf, uint256 bitmap, bytes32[] calldata siblings)
        internal
        pure
        returns (bytes32)
    {
        bytes32 node = leaf;
        bytes32 empty = EMPTY_LEAF;
        uint160 k = uint160(key);
        uint256 j = 0;

        for (uint256 i = 0; i < TREE_DEPTH; ++i) {
            bytes32 sib;
            if ((bitmap >> i) & 1 == 1) {
                if (j >= siblings.length) revert BitmapClaimsMoreSiblings();
                sib = siblings[j];
                unchecked {
                    ++j;
                }
            } else {
                sib = empty;
            }

            node = ((k >> i) & 1 == 1)
                ? keccak256(abi.encodePacked(sib, node))
                : keccak256(abi.encodePacked(node, sib));

            empty = keccak256(abi.encodePacked(empty, empty));
        }

        // Reject trailing siblings. Without this, two distinct encodings verify
        // to the same root and proof identity is no longer well defined.
        if (j != siblings.length) revert UnusedSiblings();
        return node;
    }

    /// @notice Verify an account against a root, then return the root that would
    ///         result from replacing it with (newNonce, newBalance).
    /// @dev The workhorse of every fraud proof. Callers apply updates in a fixed
    ///      order and thread the intermediate root forward, which is what makes
    ///      the sender == recipient case fall out correctly instead of needing a
    ///      special branch.
    function verifyAndUpdate(
        bytes32 root,
        address key,
        uint64 oldSeq,
        uint128 oldBalance,
        uint64 newSeq,
        uint128 newBalance,
        uint256 bitmap,
        bytes32[] calldata siblings
    ) internal pure returns (bytes32 newRoot) {
        if (computeRoot(key, accountLeaf(oldSeq, oldBalance), bitmap, siblings) != root) {
            revert AccountNotInRoot();
        }
        newRoot = computeRoot(key, accountLeaf(newSeq, newBalance), bitmap, siblings);
    }

    error AccountNotInRoot();
}
