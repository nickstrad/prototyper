import { ManagedRuntime } from "effect";
import { AppClock, AppLayer, TaskStore } from "./tasks.ts";
import type { Layer } from "effect";

export type AppRuntime = ManagedRuntime.ManagedRuntime<
  AppClock | TaskStore,
  never
>;

export const makeAppRuntime = (clock?: Layer.Layer<AppClock>): AppRuntime =>
  ManagedRuntime.make(AppLayer(clock));
