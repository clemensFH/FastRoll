/**
 * Sparse Merkle tree over the 20-byte address space. FROZEN.
 *
 * Depth is 160 because the key is the path: each bit selects a child. Every
 * possible address therefore has a slot, which is what makes absence provable.
 * An unregistered account is an ordinary inclusion proof of the empty leaf.
 *
 * Bit ordering is LSB-first. At level i we combine with the sibling using bit i
 * of the address, and a set bit means our node is the RIGHT child. MSB-first is
 * equally valid and completely incompatible, which is why this is frozen and why
 * spec/vectors/tree.json exists.
 *
 * Generic over the value type so the tree does not need to know what an account
 * is. That keeps this file free of protocol semantics and avoids a cycle with
 * state.ts, which owns the account encoding.
 */
import { concat, keccak256, type Address, type Hex } from "viem";

export const TREE_DEPTH = 160;

export interface MerkleProof {
  /** bit i set means siblings carries a real hash for level i */
  bitmap: bigint;
  siblings: Hex[];
}

export const FULL_BITMAP: bigint = (1n << BigInt(TREE_DEPTH)) - 1n;

function hashPair(left: Hex, right: Hex): Hex {
  return keccak256(concat([left, right]));
}

/** E[0] is the empty leaf, E[k] the root of an all-empty subtree of height k. */
export function emptySubtreeHashes(emptyLeaf: Hex): Hex[] {
  const e: Hex[] = [emptyLeaf];
  for (let i = 1; i <= TREE_DEPTH; i++) e.push(hashPair(e[i - 1], e[i - 1]));
  return e;
}

/**
 * Recompute the root implied by a leaf and a proof. Must agree bit-for-bit with
 * MerkleLib.computeRoot in Solidity.
 */
export function computeRoot(key: Address, leaf: Hex, proof: MerkleProof, emptyLeaf: Hex): Hex {
  const k = BigInt(key);
  let node = leaf;
  let empty = emptyLeaf;
  let j = 0;
  for (let i = 0; i < TREE_DEPTH; i++) {
    let sib: Hex;
    if ((proof.bitmap >> BigInt(i)) & 1n) {
      if (j >= proof.siblings.length) throw new Error("merkle: bitmap claims more siblings than supplied");
      sib = proof.siblings[j++];
    } else {
      sib = empty;
    }
    node = (k >> BigInt(i)) & 1n ? hashPair(sib, node) : hashPair(node, sib);
    empty = hashPair(empty, empty);
  }
  // Reject trailing siblings: without this, two encodings verify to one root
  // and proof identity is no longer well defined.
  if (j !== proof.siblings.length) throw new Error("merkle: unused siblings supplied");
  return node;
}

/**
 * Prover-side tree. Materialises only nodes on paths to non-empty leaves, so
 * storage grows with the accounts that exist, never with 2^160.
 *
 * Node identity: at level i the node covering address a is (a >> i). Level 0 is
 * the leaf, level 160 the root.
 */
export class SparseMerkleTree<V> {
  readonly emptyLeaf: Hex;
  readonly emptyHashes: readonly Hex[];

  private values = new Map<bigint, V>();
  private nodes = new Map<string, Hex>();
  private readonly emptyValue: V;
  private readonly leafOf: (v: V) => Hex;
  private readonly cloneValue: (v: V) => V;

  constructor(emptyValue: V, leafOf: (v: V) => Hex, cloneValue: (v: V) => V = (v) => ({ ...v })) {
    this.emptyValue = emptyValue;
    this.leafOf = leafOf;
    this.cloneValue = cloneValue;
    this.emptyLeaf = leafOf(emptyValue);
    this.emptyHashes = emptySubtreeHashes(this.emptyLeaf);
  }

  private static nodeKey(level: number, index: bigint): string {
    return `${level}:${index.toString(16)}`;
  }

  private node(level: number, index: bigint): Hex {
    return this.nodes.get(SparseMerkleTree.nodeKey(level, index)) ?? this.emptyHashes[level];
  }

  get(addr: Address): V {
    const v = this.values.get(BigInt(addr));
    return v ? this.cloneValue(v) : this.cloneValue(this.emptyValue);
  }

  exists(addr: Address): boolean {
    return this.values.has(BigInt(addr));
  }

  /** Occupied leaves. Leaves are never removed, so this only grows. */
  get size(): number {
    return this.values.size;
  }

  addresses(): Address[] {
    return [...this.values.keys()].map((k) => `0x${k.toString(16).padStart(40, "0")}` as Address);
  }

  set(addr: Address, value: V): void {
    const k = BigInt(addr);
    this.values.set(k, this.cloneValue(value));
    this.nodes.set(SparseMerkleTree.nodeKey(0, k), this.leafOf(value));
    for (let i = 0; i < TREE_DEPTH; i++) {
      const self = k >> BigInt(i);
      const sibHash = this.node(i, self ^ 1n);
      const selfHash = this.node(i, self);
      const parent = self & 1n ? hashPair(sibHash, selfHash) : hashPair(selfHash, sibHash);
      this.nodes.set(SparseMerkleTree.nodeKey(i + 1, k >> BigInt(i + 1)), parent);
    }
  }

  root(): Hex {
    return this.node(TREE_DEPTH, 0n);
  }

  /** Compressed proof. Works for absent accounts too, which is the point. */
  prove(addr: Address): MerkleProof {
    const k = BigInt(addr);
    let bitmap = 0n;
    const siblings: Hex[] = [];
    for (let i = 0; i < TREE_DEPTH; i++) {
      const sib = this.node(i, (k >> BigInt(i)) ^ 1n);
      if (sib !== this.emptyHashes[i]) {
        bitmap |= 1n << BigInt(i);
        siblings.push(sib);
      }
    }
    return { bitmap, siblings };
  }

  verify(addr: Address, value: V, proof: MerkleProof, root: Hex): boolean {
    return computeRoot(addr, this.leafOf(value), proof, this.emptyLeaf) === root;
  }

  /** Expand a compressed proof to the all-ones encoding. Same root, more bytes. */
  decompress(proof: MerkleProof): MerkleProof {
    const siblings: Hex[] = [];
    let j = 0;
    for (let i = 0; i < TREE_DEPTH; i++) {
      siblings.push((proof.bitmap >> BigInt(i)) & 1n ? proof.siblings[j++] : this.emptyHashes[i]);
    }
    return { bitmap: FULL_BITMAP, siblings };
  }

  clone(): SparseMerkleTree<V> {
    const t = new SparseMerkleTree(this.emptyValue, this.leafOf, this.cloneValue);
    for (const [k, v] of this.values) t.values.set(k, this.cloneValue(v));
    for (const [k, v] of this.nodes) t.nodes.set(k, v);
    return t;
  }

  /** Adopt another tree's contents in place, so holders of this reference see
   *  the update. Used when a validator resyncs from L1. */
  replaceWith(other: SparseMerkleTree<V>): void {
    this.values.clear();
    this.nodes.clear();
    for (const [k, v] of other.values) this.values.set(k, this.cloneValue(v));
    for (const [k, v] of other.nodes) this.nodes.set(k, v);
  }
}
