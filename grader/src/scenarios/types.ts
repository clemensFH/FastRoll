import type { Manifest } from "../manifest.js";
import type { World, WorldOptions } from "../world.js";

export type WorldOpts = Omit<WorldOptions, "manifest" | "basePort" | "verbose">;

export interface Ctx {
  manifest: Manifest & { rootDir: string };
  basePort: number;
  verbose: boolean;
  /** Build a world and register it for teardown. */
  world(opts: WorldOpts): Promise<World>;
  note(msg: string): void;
}

export interface Scenario {
  id: number;
  task: 1 | 2 | 3;
  title: string;
  /** What a student has to have got right. Printed with the result, because a
   *  bare scenario number tells nobody what to go and fix. */
  checks: string;
  /** What passing it is worth. All or nothing: a scenario either shows the
   *  property or it does not. Defaults to 1 when left out. */
  points?: number;
  run(ctx: Ctx): Promise<void>;
}
