/**
 * Shared assertion helper for the in-process checks.
 *
 * The repository's original suites use `node --test`, which spawns a child
 * process per file. That is the right default, but it cannot run under a
 * Windows sandbox that denies process creation, so the checks added in 3.8.0 are
 * plain scripts driven by this helper. They assert the same thing and exit
 * non-zero on failure, and they run anywhere.
 *
 * @module dsh-command-buddy-connect/test/harness
 */

/** Collects failures so one run reports every problem, not just the first. */
export function createChecker() {
  const failures = []

  /**
   * Assert one named condition.
   *
   * @param name - what is being asserted.
   * @param condition - the result.
   * @param detail - extra context printed on failure.
   * @returns whether it passed.
   */
  function check(name, condition, detail) {
    if (condition) {
      console.log(`  ok   ${name}`)
      return true
    }
    failures.push(detail === undefined ? name : `${name} — ${detail}`)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
    return false
  }

  /** Print the summary and set the exit code. */
  function finish() {
    if (failures.length > 0) {
      console.error(`\n${failures.length} check(s) failed`)
      process.exitCode = 1
    } else {
      console.log('\nall checks passed')
    }
  }

  return { check, finish, failures }
}
