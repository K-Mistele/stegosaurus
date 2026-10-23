import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

describe("backend", () => {
  it.effect("runs effects", () =>
    Effect.gen(function* () {
      const greeting = yield* Effect.succeed("Hello from the backend");
      expect(greeting).toBe("Hello from the backend");
    }),
  );
});
