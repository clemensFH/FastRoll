// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CertData, Protocol} from "../src/lib/Protocol.sol";
import {MerkleLib} from "../src/lib/MerkleLib.sol";
import {RLPTx} from "../src/lib/RLPTx.sol";

/// Calldata harnesses. The libraries take calldata slices, so drive them through
/// external calls the way the Gateway does.
contract Harness {
    function computeRoot(address key, bytes32 leaf, uint256 bitmap, bytes32[] calldata siblings)
        external
        pure
        returns (bytes32)
    {
        return MerkleLib.computeRoot(key, leaf, bitmap, siblings);
    }

    function decode(bytes calldata raw, uint256 chainId) external pure returns (RLPTx.Tx memory) {
        return RLPTx.decode(raw, chainId);
    }

    function certs(bytes calldata blob) external pure returns (CertData.Cert[] memory) {
        return CertData.decode(blob);
    }

    function certSigner(bytes calldata blob, uint256 index, uint256 i, uint256 chainId)
        external
        pure
        returns (address)
    {
        CertData.Cert memory c = CertData.decode(blob)[index];
        CertData.Signature memory sig = c.signatures[i];
        return ecrecover(Protocol.voteDigest(chainId, c.epoch, keccak256(c.order)), sig.v, sig.r, sig.s);
    }
}

/// @notice Reads the same spec/vectors/*.json the TypeScript suite reads.
contract ConformanceTest is Test {
    Harness h;
    string cJson;
    string tJson;
    string certJson;
    string rJson;

    function setUp() public {
        h = new Harness();
        cJson = vm.readFile("spec/vectors/constants.json");
        tJson = vm.readFile("spec/vectors/tree.json");
        certJson = vm.readFile("spec/vectors/certificate.json");
        rJson = vm.readFile("spec/vectors/replay.json");
    }

    function _u(string memory json, string memory path) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, path));
    }

    // ------------------------------------------------------------ constants

    function test_ConstantsMatchTypeScript() public view {
        assertEq(Protocol.COMMITTEE_SIZE, vm.parseJsonUint(cJson, ".committeeSize"), "committeeSize");
        assertEq(Protocol.QUORUM, vm.parseJsonUint(cJson, ".quorum"), "quorum");
        assertEq(Protocol.MAX_FAULTY, vm.parseJsonUint(cJson, ".maxFaulty"), "maxFaulty");
        assertEq(Protocol.GAS_PER_TX, _u(cJson, ".gasPerTx"), "gasPerTx");
        assertEq(Protocol.EPOCH_BLOCKS, _u(cJson, ".epochBlocks"), "epochBlocks");
        assertEq(Protocol.UNBONDING_EPOCHS, _u(cJson, ".unbondingEpochs"), "unbonding");
        assertEq(Protocol.WITHDRAW_PRECOMPILE, vm.parseJsonAddress(cJson, ".withdrawPrecompile"), "wd");
        assertEq(MerkleLib.TREE_DEPTH, vm.parseJsonUint(cJson, ".treeDepth"), "treeDepth");
    }

    /// 3f+1 with a 2f+1 quorum. If this fails the safety argument is gone.
    function test_QuorumArithmetic() public pure {
        assertEq(Protocol.COMMITTEE_SIZE, 3 * Protocol.MAX_FAULTY + 1);
        assertEq(Protocol.QUORUM, 2 * Protocol.MAX_FAULTY + 1);
    }

    function test_EpochMathMatchesTypeScript() public view {
        for (uint256 i = 0; i < 6; ++i) {
            string memory base = string.concat(".epochs[", vm.toString(i), "]");
            uint256 blk = _u(cJson, string.concat(base, ".l1Block"));
            assertEq(uint256(Protocol.epochOf(blk)), _u(cJson, string.concat(base, ".epoch")), "epochOf");
            assertEq(
                Protocol.snapshotBlock(Protocol.epochOf(blk)),
                _u(cJson, string.concat(base, ".snapshotBlock")),
                "snapshotBlock"
            );
        }
    }

    function test_ChainIdIsDistinctPerL2() public pure {
        assertEq(Protocol.chainIdForL2(7), 90007);
        assertTrue(Protocol.chainIdForL2(1) != Protocol.chainIdForL2(2));
    }

    // ----------------------------------------------------------- state leaf

    /// MerkleLib caches the empty leaf as a constant, so it must agree with the
    /// account encoding. Changing one without the other fails here.
    function test_EmptyLeafAgreesEverywhere() public view {
        bytes32 fromVector = vm.parseJsonBytes32(tJson, ".emptyLeaf");
        assertEq(Protocol.emptyLeaf(), fromVector, "Protocol");
        assertEq(MerkleLib.EMPTY_LEAF, fromVector, "MerkleLib constant");
    }

    function test_EmptySubtreeChainReachesTheEmptyRoot() public view {
        bytes32 e = MerkleLib.EMPTY_LEAF;
        for (uint256 i = 0; i < MerkleLib.TREE_DEPTH; ++i) {
            e = keccak256(abi.encodePacked(e, e));
        }
        assertEq(e, vm.parseJsonBytes32(tJson, ".emptyRoot"), "emptyRoot");
        // The constant a deployment uses as its genesis root has to be this
        // value, or the first batch is unchallengeable.
        assertEq(MerkleLib.EMPTY_ROOT, e, "EMPTY_ROOT constant");
    }

    function test_AccountLeafEncoding() public view {
        for (uint256 i = 0; i < 4; ++i) {
            string memory base = string.concat(".accounts[", vm.toString(i), "]");
            assertEq(
                Protocol.accountLeaf(
                    uint64(_u(tJson, string.concat(base, ".nextSequence"))),
                    uint128(_u(tJson, string.concat(base, ".balance")))
                ),
                vm.parseJsonBytes32(tJson, string.concat(base, ".leaf")),
                "accountLeaf"
            );
        }
    }

    // -------------------------------------------------------------- merkle

    function test_CompressedAndUncompressedProofsAgree() public view {
        address key = vm.parseJsonAddress(tJson, ".inclusion.address");
        bytes32 leaf = vm.parseJsonBytes32(tJson, ".inclusion.leaf");
        bytes32 root = vm.parseJsonBytes32(tJson, ".root");

        assertEq(
            h.computeRoot(
                key,
                leaf,
                _u(tJson, ".inclusion.compressed.bitmap"),
                vm.parseJsonBytes32Array(tJson, ".inclusion.compressed.siblings")
            ),
            root,
            "compressed"
        );

        bytes32[] memory full = vm.parseJsonBytes32Array(tJson, ".inclusion.uncompressed.siblings");
        assertEq(full.length, MerkleLib.TREE_DEPTH, "uncompressed length");
        assertEq(h.computeRoot(key, leaf, _u(tJson, ".inclusion.uncompressed.bitmap"), full), root, "full");
    }

    /// Absence is an ordinary inclusion proof of the empty leaf. That is the
    /// whole reason the tree spans the full address space.
    function test_AbsenceProofVerifies() public view {
        assertEq(
            h.computeRoot(
                vm.parseJsonAddress(tJson, ".absence.address"),
                MerkleLib.EMPTY_LEAF,
                _u(tJson, ".absence.compressed.bitmap"),
                vm.parseJsonBytes32Array(tJson, ".absence.compressed.siblings")
            ),
            vm.parseJsonBytes32(tJson, ".root"),
            "absence"
        );
    }

    function test_RevertOnTrailingSiblings() public {
        bytes32[] memory sibs = vm.parseJsonBytes32Array(tJson, ".inclusion.compressed.siblings");
        bytes32[] memory padded = new bytes32[](sibs.length + 1);
        for (uint256 i = 0; i < sibs.length; ++i) {
            padded[i] = sibs[i];
        }
        padded[sibs.length] = MerkleLib.EMPTY_LEAF;
        vm.expectRevert(MerkleLib.UnusedSiblings.selector);
        h.computeRoot(
            vm.parseJsonAddress(tJson, ".inclusion.address"),
            vm.parseJsonBytes32(tJson, ".inclusion.leaf"),
            _u(tJson, ".inclusion.compressed.bitmap"),
            padded
        );
    }

    // ----------------------------------------------------------- vote digest

    function test_VoteDigestMatchesTypeScript() public view {
        bytes memory order = vm.parseJsonBytes(certJson, ".order");
        assertEq(
            Protocol.voteDigest(
                vm.parseJsonUint(certJson, ".chainId"), uint64(_u(certJson, ".epoch")), keccak256(order)
            ),
            vm.parseJsonBytes32(certJson, ".voteDigest"),
            "voteDigest"
        );
    }

    /// The epoch is inside the digest, which is what makes certificates expire
    /// at the boundary instead of carrying old votes across it.
    function test_VoteDigestBindsEpochAndChainId() public pure {
        bytes32 oh = keccak256("order");
        assertTrue(Protocol.voteDigest(90007, 3, oh) != Protocol.voteDigest(90007, 4, oh));
        assertTrue(Protocol.voteDigest(90007, 3, oh) != Protocol.voteDigest(90008, 3, oh));
    }

    function test_CertificateIdMatchesTypeScript() public view {
        bytes memory order = vm.parseJsonBytes(certJson, ".order");
        assertEq(
            Protocol.certificateId(uint64(_u(certJson, ".epoch")), keccak256(order)),
            vm.parseJsonBytes32(certJson, ".certificateId"),
            "certificateId"
        );
    }

    // -------------------------------------------------------- cert data blob

    function test_CertDataParsesAndRecoversEverySigner() public view {
        bytes memory blob = vm.parseJsonBytes(certJson, ".certData");
        uint256 chainId = vm.parseJsonUint(certJson, ".chainId");

        CertData.Cert[] memory list = h.certs(blob);
        assertEq(list.length, 1, "one certificate");

        CertData.Cert memory c = list[0];
        assertEq(uint256(c.epoch), _u(certJson, ".epoch"), "epoch");
        assertEq(c.signatures.length, Protocol.QUORUM, "quorum signatures");
        assertEq(keccak256(c.order), keccak256(vm.parseJsonBytes(certJson, ".order")), "order");

        for (uint256 i = 0; i < c.signatures.length; ++i) {
            assertEq(
                h.certSigner(blob, 0, i, chainId),
                vm.parseJsonAddress(certJson, string.concat(".signers[", vm.toString(i), "]")),
                "signer"
            );
        }
    }

    function test_CertDataParsesTwoCertificates() public view {
        assertEq(h.certs(vm.parseJsonBytes(certJson, ".certDataTwo")).length, 2, "two certificates");
    }

    /// A truncated blob must be detectable, because postBatch rejects one that
    /// does not parse rather than storing it for someone to challenge.
    function test_CertDataRejectsTruncation() public {
        bytes memory blob = vm.parseJsonBytes(certJson, ".certData");
        bytes memory cut = new bytes(blob.length - 33);
        for (uint256 i = 0; i < cut.length; ++i) {
            cut[i] = blob[i];
        }
        // A revert, not a false: `abi.decode` bounds-checks itself and has no
        // non-reverting form. The outcome that matters is the same one, which
        // is that a truncated blob cannot be mistaken for a certificate list.
        vm.expectRevert();
        h.certs(cut);
    }

    // ------------------------------------------------------------- rlp order

    /// Decode every order in the replay vector and check Solidity agrees with
    /// viem on the hash, the sender, the sequence, the amount and the kind.
    function test_DecodesEveryOrderInTheReplayVector() public view {
        uint256 chainId = vm.parseJsonUint(rJson, ".chainId");
        uint256 withdrawals;
        uint256 n = 5;

        for (uint256 i = 0; i < n; ++i) {
            string memory step = string.concat(".steps[", vm.toString(i), "]");
            bytes memory raw = vm.parseJsonBytes(rJson, string.concat(".raws[", vm.toString(i), "]"));
            RLPTx.Tx memory t = h.decode(raw, chainId);

            assertEq(keccak256(raw), vm.parseJsonBytes32(rJson, string.concat(step, ".orderHash")), "hash");
            assertEq(t.sender, vm.parseJsonAddress(rJson, string.concat(step, ".sender")), "sender");
            assertEq(uint256(t.nonce), _u(rJson, string.concat(step, ".sequence")), "sequence");
            assertEq(uint256(t.value), _u(rJson, string.concat(step, ".amount")), "amount");

            bool isWithdraw =
                keccak256(bytes(vm.parseJsonString(rJson, string.concat(step, ".kind"))))
                == keccak256("withdraw");
            assertTrue(isWithdraw ? t.kind == RLPTx.Kind.Withdraw : t.kind == RLPTx.Kind.Transfer, "kind");
            if (isWithdraw) ++withdrawals;
        }
        assertEq(withdrawals, 1, "fixture must cover a withdrawal");
    }

    function test_DecodesTheCertificateOrder() public view {
        bytes memory order = vm.parseJsonBytes(certJson, ".order");
        RLPTx.Tx memory t = h.decode(order, vm.parseJsonUint(certJson, ".chainId"));
        assertTrue(t.sender != address(0), "sender recovered");
        assertTrue(t.kind == RLPTx.Kind.Transfer, "plain transfer");
        assertEq(uint256(t.fee), uint256(t.gasPrice) * Protocol.GAS_PER_TX, "fee is a pure function");
    }

    /// Every decoder refuses exactly the same out-of-range integers, so an order
    /// that is a no-op off chain is a no-op on chain too.
    function test_BoundsMatchTheVectors() public view {
        uint256 chainId = vm.parseJsonUint(certJson, ".chainId");
        for (uint256 i = 0; i < 8; i++) {
            string memory c = string.concat(".bounds[", vm.toString(i), "]");
            bytes memory raw = vm.parseJsonBytes(certJson, string.concat(c, ".raw"));
            bool expected = vm.parseJsonBool(certJson, string.concat(c, ".decodes"));
            bool decoded;
            try h.decode(raw, chainId) returns (RLPTx.Tx memory) {
                decoded = true;
            } catch {
                decoded = false;
            }
            assertEq(decoded, expected, vm.parseJsonString(certJson, string.concat(c, ".name")));
        }
    }

    function test_RevertOnWrongChainId() public {
        bytes memory order = vm.parseJsonBytes(certJson, ".order");
        vm.expectRevert(RLPTx.WrongChainId.selector);
        h.decode(order, vm.parseJsonUint(certJson, ".chainId") + 1);
    }
}
