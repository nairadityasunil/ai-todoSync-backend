import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";

import { JobLockModel, runExclusive } from "./job-lock.js";

const execOf = (fn: () => Promise<unknown>) => ({ exec: fn }) as any;

afterEach(() => {
  mock.restoreAll();
});

describe("runExclusive", () => {
  test("runs the task and releases the lock when it is free", async () => {
    mock.method(JobLockModel, "findOneAndUpdate", () =>
      execOf(async () => null),
    );
    const release = mock.method(JobLockModel, "updateOne", () =>
      execOf(async () => ({})),
    );
    let ran = false;

    const result = await runExclusive("job", 1000, async () => {
      ran = true;
    });

    assert.equal(result, true);
    assert.equal(ran, true);
    assert.equal(release.mock.callCount(), 1);
  });

  test("skips the task when another run holds the lock", async () => {
    mock.method(JobLockModel, "findOneAndUpdate", () =>
      execOf(async () => {
        throw Object.assign(new Error("E11000"), { code: 11000 });
      }),
    );
    let ran = false;

    const result = await runExclusive("job", 1000, async () => {
      ran = true;
    });

    assert.equal(result, false);
    assert.equal(ran, false);
  });

  test("releases the lock even if the task throws", async () => {
    mock.method(JobLockModel, "findOneAndUpdate", () =>
      execOf(async () => null),
    );
    const release = mock.method(JobLockModel, "updateOne", () =>
      execOf(async () => ({})),
    );

    await assert.rejects(
      runExclusive("job", 1000, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(release.mock.callCount(), 1);
  });
});
