// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Protocol} from "./Protocol.sol";

/// @title RLPTx - decode and authenticate a legacy Ethereum transaction. FROZEN.
/// @notice An L2 transaction IS a legacy Ethereum transaction, so students sign
///         with `cast send` and their L1 key works on every rollup in the class.
///         The price of that is this decoder.
///
///         Strict on purpose: an honest poster never includes anything that
///         fails here. If a batch does carry one, inside a blob that parses,
///         that certificate is a no-op step: the off-chain replay skips it and
///         the step proofs expect the root unchanged, so the batch is not wrong
///         for containing it, and nothing can withdraw against it.
library RLPTx {
    enum Kind {
        Transfer,
        Withdraw
    }

    struct Tx {
        address sender;
        uint64 nonce;
        uint256 gasPrice;
        uint256 gas;
        address to;
        uint128 value;
        Kind kind;
        /// transfer: the L2 recipient. withdraw: the L1 recipient.
        address recipient;
        uint128 fee;
    }

    error NotAList();
    error Truncated();
    error BadItemCount();
    error LeadingZeros();
    error NonCanonicalLength();
    error TrailingBytes();
    error HighS();

    /// n / 2 for secp256k1.
    uint256 private constant SECP256K1_HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    error IntegerTooLong();
    error BadToLength();
    error WrongChainId();
    error BadSignature();
    /// @dev 2^53 - 1. See the nonce check in `_readUnsigned`.
    uint256 internal constant MAX_NONCE = 9007199254740991;

    error WrongGas();
    error NonceTooLarge();
    error ValueTooLarge();
    error FeeTooLarge();
    error BadPayload();
    error TransferMustCarryNoData();
    error ZeroRecipient();
    error ZeroValue();

    // ------------------------------------------------------------- RLP reader

    struct Cursor {
        uint256 ptr;
        uint256 end;
    }

    /// @dev Returns the offset and length of the next item's payload, and
    ///      whether it was encoded as a list.
    function _item(bytes calldata raw, Cursor memory c)
        private
        pure
        returns (uint256 off, uint256 len, bool isList)
    {
        if (c.ptr >= c.end) revert Truncated();
        uint8 b = uint8(raw[c.ptr]);

        if (b <= 0x7f) {
            // single byte, its own encoding
            off = c.ptr;
            len = 1;
            c.ptr += 1;
        } else if (b <= 0xb7) {
            off = c.ptr + 1;
            len = b - 0x80;
            c.ptr = off + len;
        } else if (b <= 0xbf) {
            uint256 lenOfLen = b - 0xb7;
            len = _be(raw, c.ptr + 1, lenOfLen);
            // A long form that a short form could have expressed is a second
            // encoding of the same value. See _requireMinimal.
            _requireMinimal(raw, c.ptr + 1, lenOfLen, len, 55);
            off = c.ptr + 1 + lenOfLen;
            c.ptr = off + len;
        } else if (b <= 0xf7) {
            isList = true;
            off = c.ptr + 1;
            len = b - 0xc0;
            c.ptr = off + len;
        } else {
            isList = true;
            uint256 lenOfLen2 = b - 0xf7;
            len = _be(raw, c.ptr + 1, lenOfLen2);
            _requireMinimal(raw, c.ptr + 1, lenOfLen2, len, 55);
            off = c.ptr + 1 + lenOfLen2;
            c.ptr = off + len;
        }
        if (c.ptr > c.end) revert Truncated();
    }

    /// @dev A long-form length must be minimal: no leading zero bytes, and not
    ///      encoding a length a short form could have carried.
    ///
    ///      This is not pedantry. `0xf8 0x6e ...` and `0xf9 0x00 0x6e ...` are
    ///      the same list with the same items and the same recovered sender, but
    ///      different keccak256(raw). Equivocation is defined as "same sender,
    ///      same sequence, different bytes", so without this anyone who sees an
    ///      honest signed order can re-encode it and accuse that
    ///      account of equivocating.
    function _requireMinimal(
        bytes calldata raw,
        uint256 off,
        uint256 lenOfLen,
        uint256 len,
        uint256 shortMax
    ) private pure {
        if (uint8(raw[off]) == 0) revert NonCanonicalLength();
        if (len <= shortMax) revert NonCanonicalLength();
        if (lenOfLen > 1 && len < 256) revert NonCanonicalLength();
    }

    function _be(bytes calldata raw, uint256 off, uint256 len) private pure returns (uint256 v) {
        if (len == 0 || len > 8) revert IntegerTooLong();
        if (off + len > raw.length) revert Truncated();
        for (uint256 i = 0; i < len; ++i) {
            v = (v << 8) | uint8(raw[off + i]);
        }
    }

    /// @dev Canonical integers only: no leading zero bytes, so one value has one
    ///      encoding and a transaction has one hash.
    function _uintAt(bytes calldata raw, uint256 off, uint256 len) private pure returns (uint256 v) {
        if (len == 0) return 0;
        if (len > 32) revert IntegerTooLong();
        if (uint8(raw[off]) == 0) revert LeadingZeros();
        for (uint256 i = 0; i < len; ++i) {
            v = (v << 8) | uint8(raw[off + i]);
        }
    }

    // --------------------------------------------------------------- decoding

    /// @notice Decode, authenticate and validate one raw signed transaction.
    /// @param expectedChainId Protocol.chainIdForL2(l2Id). A mismatch is fatal:
    ///        without the check one signed transaction replays on every rollup
    ///        in the class, since addresses and nonce spaces are shared.
    /// @dev Split across small frames on purpose. Decoding nine RLP items plus
    ///      an ecrecover in one function overflows the stack in the legacy
    ///      pipeline. The build uses via_ir anyway, for contract size (see
    ///      foundry.toml), but this keeps the decoder compiling without it.
    function decode(bytes calldata raw, uint256 expectedChainId) internal pure returns (Tx memory t) {
        Cursor memory c = Cursor({ptr: 0, end: raw.length});
        (uint256 listOff, uint256 listLen, bool isList) = _item(raw, c);
        if (!isList) revert NotAList();
        // Nothing may follow the list. Padding bytes are ignored by the
        // decoder, change the hash, and recover the same sender, which is the
        // same freeze attack as a non-minimal length prefix.
        if (listOff + listLen != raw.length) revert TrailingBytes();

        Cursor memory f = Cursor({ptr: listOff, end: listOff + listLen});
        (uint256 dataOff, uint256 dataLen, uint256 sixEnd) = _readUnsigned(raw, f, t);

        t.sender = _recover(raw, f, listOff, sixEnd, expectedChainId);
        t.fee = uint128(t.gasPrice * Protocol.GAS_PER_TX);
        (t.kind, t.recipient) = _classify(raw, t.to, dataOff, dataLen);
        if (t.kind != Kind.Transfer && t.value == 0) revert ZeroValue();
    }

    /// @dev Fills nonce, gasPrice, gas, to and value on `t`, and reports where
    ///      the data field sits plus where the first six items end. Items 0..5
    ///      are byte-identical in the signed and unsigned encodings, so the
    ///      signing hash slices them rather than re-encoding.
    function _readUnsigned(bytes calldata raw, Cursor memory f, Tx memory t)
        private
        pure
        returns (uint256 dataOff, uint256 dataLen, uint256 sixEnd)
    {
        (uint256 o, uint256 l,) = _item(raw, f);
        // Every integer is bounded HERE, at decode, and never by a cast later.
        // A cast truncates silently, and the off-chain decoders hold these as
        // unbounded integers, so a nonce of 2^64 + n or a fee past uint128
        // would apply on chain and be a no-op off it: an honest poster slashed
        // for the difference.
        //
        // The nonce bound is 2^53 - 1 rather than the leaf's uint64, because
        // that is the largest nonce viem decodes, and every decoder must
        // refuse the same orders. No account gets near it.
        uint256 n = _uintAt(raw, o, l);
        if (n > MAX_NONCE) revert NonceTooLarge();
        t.nonce = uint64(n);
        (o, l,) = _item(raw, f);
        t.gasPrice = _uintAt(raw, o, l);
        if (t.gasPrice > type(uint128).max / Protocol.GAS_PER_TX) revert FeeTooLarge();
        (o, l,) = _item(raw, f);
        t.gas = _uintAt(raw, o, l);
        if (t.gas != Protocol.GAS_PER_TX) revert WrongGas();

        (o, l,) = _item(raw, f);
        if (l != 20) revert BadToLength();
        t.to = address(bytes20(raw[o:o + 20]));

        (o, l,) = _item(raw, f);
        uint256 v = _uintAt(raw, o, l);
        if (v > type(uint128).max) revert ValueTooLarge();
        t.value = uint128(v);

        (dataOff, dataLen,) = _item(raw, f);
        sixEnd = f.ptr;
    }

    /// @dev Reads v, r, s, checks EIP-155 chainId, and recovers the sender.
    function _recover(
        bytes calldata raw,
        Cursor memory f,
        uint256 listOff,
        uint256 sixEnd,
        uint256 expectedChainId
    ) private pure returns (address sender) {
        (uint256 o, uint256 l,) = _item(raw, f);
        uint256 vParam = _uintAt(raw, o, l);
        (o, l,) = _item(raw, f);
        bytes32 r = bytes32(raw[o:o + l]) >> ((32 - l) * 8);
        (o, l,) = _item(raw, f);
        bytes32 s = bytes32(raw[o:o + l]) >> ((32 - l) * 8);
        if (f.ptr != f.end) revert BadItemCount();

        // Low-s only, per EIP-2. (r, s) and (r, n - s) are both valid over the
        // same message with the same signer, so the high-s twin is a second
        // encoding that every other canonicality check here would let through.
        // ecrecover does not reject it, so this must.
        if (uint256(s) > SECP256K1_HALF_N) revert HighS();

        // EIP-155: v = chainId * 2 + 35 + recoveryBit
        if (vParam < 35) revert WrongChainId();
        if ((vParam - 35) >> 1 != expectedChainId) revert WrongChainId();

        sender = ecrecover(
            _signingHash(raw, listOff, sixEnd, expectedChainId), uint8((vParam - 35) & 1) + 27, r, s
        );
        if (sender == address(0)) revert BadSignature();
    }

    /// @dev The signing payload is RLP([nonce, gasPrice, gas, to, value, data,
    ///      chainId, 0, 0]). Items 0..5 are byte-identical to the signed
    ///      transaction, so slice them and append the EIP-155 tail.
    function _signingHash(bytes calldata raw, uint256 listOff, uint256 sixEnd, uint256 chainId)
        private
        pure
        returns (bytes32)
    {
        bytes memory tail = abi.encodePacked(_rlpUint(chainId), hex"8080");
        bytes memory body = abi.encodePacked(raw[listOff:sixEnd], tail);
        return keccak256(abi.encodePacked(_listHeader(body.length), body));
    }

    function _rlpUint(uint256 x) private pure returns (bytes memory) {
        if (x == 0) return hex"80";
        if (x < 0x80) return abi.encodePacked(uint8(x));
        uint256 len = 0;
        uint256 y = x;
        while (y != 0) {
            ++len;
            y >>= 8;
        }
        bytes memory out = new bytes(len + 1);
        out[0] = bytes1(uint8(0x80 + len));
        for (uint256 i = 0; i < len; ++i) {
            out[len - i] = bytes1(uint8(x >> (8 * i)));
        }
        return out;
    }

    function _listHeader(uint256 len) private pure returns (bytes memory) {
        if (len <= 55) return abi.encodePacked(uint8(0xc0 + len));
        uint256 lenOfLen = 0;
        uint256 y = len;
        while (y != 0) {
            ++lenOfLen;
            y >>= 8;
        }
        bytes memory out = new bytes(lenOfLen + 1);
        out[0] = bytes1(uint8(0xf7 + lenOfLen));
        for (uint256 i = 0; i < lenOfLen; ++i) {
            out[lenOfLen - i] = bytes1(uint8(len >> (8 * i)));
        }
        return out;
    }

    function _classify(bytes calldata raw, address to, uint256 dataOff, uint256 dataLen)
        private
        pure
        returns (Kind kind, address recipient)
    {
        if (to == Protocol.WITHDRAW_PRECOMPILE) {
            if (dataLen != 32) revert BadPayload();
            recipient = address(uint160(uint256(bytes32(raw[dataOff:dataOff + 32]))));
            if (recipient == address(0)) revert ZeroRecipient();
            return (Kind.Withdraw, recipient);
        }
        if (dataLen != 0) revert TransferMustCarryNoData();
        if (to == address(0)) revert ZeroRecipient();
        return (Kind.Transfer, to);
    }
}
