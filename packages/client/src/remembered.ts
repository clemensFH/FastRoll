/**
 * What a client remembers about an order it drove, per order hash, for as long
 * as it is still true.
 *
 * Everything remembered here rests on a certificate, and a certificate expires
 * at its epoch's boundary: every validator refuses it in the next epoch, and
 * the order has to be collected again, fresh. So an entry from an earlier
 * epoch is not an answer, and asking for one forgets it.
 */
export class Remembered<T extends { epoch: bigint }> {
  private readonly entries = new Map<string, T>();

  set(hash: string, value: T): void {
    this.entries.set(hash.toLowerCase(), value);
  }

  /** The entry, if it is from `epoch`. An entry from another epoch is dropped. */
  get(hash: string, epoch: bigint): T | undefined {
    const k = hash.toLowerCase();
    const v = this.entries.get(k);
    if (v && v.epoch !== epoch) {
      this.entries.delete(k);
      return undefined;
    }
    return v;
  }

  /** The entry whatever its epoch, for reading what happened rather than
   *  deciding what to do next. */
  peek(hash: string): T | undefined {
    return this.entries.get(hash.toLowerCase());
  }

  delete(hash: string): void {
    this.entries.delete(hash.toLowerCase());
  }

  get size(): number {
    return this.entries.size;
  }
}
