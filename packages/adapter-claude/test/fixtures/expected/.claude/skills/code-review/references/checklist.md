# Review checklist

## Correctness

- Are error paths handled, or only the happy path?
- Are boundary conditions covered (empty, single element, maximum)?
- Can any input reach the filesystem or a query without validation?

## Tests

- Does every behaviour change have a test?
- Would the test fail if the change were reverted?

## Public API

- Does this change an exported signature?
- Is the change documented in the changelog?
