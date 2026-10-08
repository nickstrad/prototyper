// Portable application core: no React, xterm, just-bash or Deno APIs here.
import { Context, Effect, Layer, Ref, Schema } from "effect";

export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  { message: Schema.String },
) {}

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()(
  "TaskNotFound",
  { id: Schema.Number },
) {}

export type TaskError = InvalidInput | TaskNotFound;

export interface Task {
  readonly id: number;
  readonly title: string;
  readonly completed: boolean;
  readonly createdAt: string;
}

/** Injected clock so timestamps are deterministic in tests. */
export class AppClock extends Context.Service<AppClock, {
  readonly now: Effect.Effect<Date>;
}>()("AppClock") {
  static readonly live = Layer.succeed(this)({
    now: Effect.sync(() => new Date()),
  });
  static fixed(iso: string) {
    return Layer.succeed(this)({ now: Effect.succeed(new Date(iso)) });
  }
}

interface StoreState {
  readonly nextId: number;
  readonly tasks: readonly Task[];
}

export class TaskStore extends Context.Service<TaskStore, {
  readonly state: Ref.Ref<StoreState>;
}>()("TaskStore") {
  static readonly memory = Layer.effect(this)(
    Effect.map(Ref.make<StoreState>({ nextId: 1, tasks: [] }), (state) => ({
      state,
    })),
  );
}

const Title = Schema.String.check(Schema.isNonEmpty());

export const createTask = (
  title: string,
): Effect.Effect<Task, InvalidInput, AppClock | TaskStore> =>
  Effect.gen(function* () {
    const valid = yield* Schema.decodeUnknownEffect(Title)(title.trim()).pipe(
      Effect.mapError(() => new InvalidInput({ message: "title is required" })),
    );
    const clock = yield* AppClock;
    const { state } = yield* TaskStore;
    const now = yield* clock.now;
    return yield* Ref.modify(state, (s): [Task, StoreState] => {
      const task: Task = {
        id: s.nextId,
        title: valid,
        completed: false,
        createdAt: now.toISOString(),
      };
      return [task, { nextId: s.nextId + 1, tasks: [...s.tasks, task] }];
    });
  });

export const listTasks: Effect.Effect<readonly Task[], never, TaskStore> =
  Effect.gen(function* () {
    const { state } = yield* TaskStore;
    return (yield* Ref.get(state)).tasks;
  });

export const completeTask = (
  id: number,
): Effect.Effect<Task, TaskNotFound, TaskStore> =>
  Effect.gen(function* () {
    const { state } = yield* TaskStore;
    const s = yield* Ref.get(state);
    const found = s.tasks.find((t) => t.id === id);
    if (!found) return yield* new TaskNotFound({ id });
    const done: Task = { ...found, completed: true };
    yield* Ref.set(state, {
      ...s,
      tasks: s.tasks.map((t) => (t.id === id ? done : t)),
    });
    return done;
  });

export const AppLayer = (clock: Layer.Layer<AppClock> = AppClock.live) =>
  Layer.mergeAll(clock, TaskStore.memory);
