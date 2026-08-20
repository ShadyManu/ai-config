---
paths:
  - "backend/**"
  - "services/**/*.ts"
---

Backend development rules

- Validate every request body at the boundary; never trust client input.
- Use dependency injection for service classes so they can be tested in isolation.
- Return typed error results rather than throwing for expected failures.
